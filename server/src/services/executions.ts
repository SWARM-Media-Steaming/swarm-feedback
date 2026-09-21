import type { AppConfig } from '../config.js';
import type { Actor } from '../actors.js';
import { writeAudit } from '../audit.js';
import {
  assertNoCredentialKeys,
  batchEnvelopeSchema,
  executionUpdateSchema,
  executionUploadSchema,
  parseBody,
  repositoryKeyOf,
  type ExecutionUpdate,
  type ExecutionUpload,
} from '../domain.js';
import { AppError } from '../errors.js';
import { toExecutionDto, toQueueItem, toReviewDto, toStatusDto } from '../present.js';
import type { ExecutionQuery, ExecutionRecord } from '../records.js';
import type { Repositories } from '../repos/types.js';
import {
  canonicalStringify,
  encryptOptional,
  encryptString,
  redactSecrets,
  sha256Hex,
  timingSafeEqualText,
  type SecretFinding,
} from '../security.js';
import { withExecution } from './mutate.js';

const MAX_ITEM_BYTES = 350_000;

export async function uploadExecution(config: AppConfig, repos: Repositories, installationId: string, body: unknown, ip: string | undefined) {
  const parsed = parseBody(executionUploadSchema, body);
  assertNoCredentialKeys(parsed);
  const redacted = redactSecrets(parsed);
  const upload = redacted.value as ExecutionUpload;
  const contentHash = sha256Hex(canonicalStringify(upload));
  const existing = await repos.executions.get(upload.executionId);
  if (existing) return finishExisting(repos, installationId, existing, contentHash, ip);
  const installation = await repos.installations.get(installationId);
  if (!installation || installation.status !== 'active') throw new AppError(403, 'forbidden', 'Installation is not active');
  const record = toStoredExecution(config, upload, installation.installationId, installation.name, contentHash, redacted.findings);
  assertItemSize(record);
  const created = await repos.executions.create(record);
  if (created === 'exists') {
    const raced = await repos.executions.get(upload.executionId);
    if (!raced) throw new AppError(409, 'execution_conflict', 'Execution ID already exists');
    return finishExisting(repos, installationId, raced, contentHash, ip);
  }
  await writeAudit(repos, { kind: 'installation', installationId }, 'execution.created', 'execution', record.executionId, ip, findingMetadata(redacted.findings));
  if (redacted.findings.length > 0) {
    await writeAudit(repos, { kind: 'installation', installationId }, 'execution.secrets_redacted', 'execution', record.executionId, ip, findingMetadata(redacted.findings));
  }
  return { execution: record, duplicate: false };
}

export async function uploadBatch(config: AppConfig, repos: Repositories, installationId: string, body: unknown, ip: string | undefined) {
  const envelope = parseBody(batchEnvelopeSchema, body);
  const results = [];
  for (const item of envelope.executions) {
    const executionId = item && typeof item === 'object' && 'executionId' in item ? String((item as { executionId?: unknown }).executionId ?? '') : '';
    try {
      const uploaded = await uploadExecution(config, repos, installationId, item, ip);
      results.push({
        executionId: uploaded.execution.executionId,
        status: uploaded.duplicate ? 'duplicate' as const : 'created' as const,
        processingStatus: uploaded.execution.processingStatus,
        reviewStatus: uploaded.execution.reviewStatus,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      results.push({
        executionId: executionId || null,
        status: 'error' as const,
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
    }
  }
  return { results };
}

async function finishExisting(repos: Repositories, installationId: string, existing: ExecutionRecord, contentHash: string, ip: string | undefined) {
  if (existing.installationId !== installationId || !timingSafeEqualText(existing.contentHash, contentHash)) {
    throw new AppError(409, 'execution_conflict', 'Execution ID already exists');
  }
  await writeAudit(repos, { kind: 'installation', installationId }, 'execution.duplicate', 'execution', existing.executionId, ip);
  return { execution: existing, duplicate: true };
}

export async function getExecutionDetail(config: AppConfig, repos: Repositories, actor: Actor, executionId: string) {
  const record = await requireExecution(repos, actor, executionId);
  if (actor.kind === 'installation') {
    return { execution: toExecutionDto(config, record, 'customer'), feedbackAvailable: await hasFeedback(repos, record.executionId) };
  }
  const review = await linkedReview(repos, record.reviewId);
  const automated = await linkedReview(repos, record.automatedReviewId);
  return {
    execution: toExecutionDto(config, record, 'reviewer'),
    review: review ? toReviewDto(config, review) : null,
    automatedReview: automated ? toReviewDto(config, automated) : null,
  };
}

export async function getExecutionStatus(repos: Repositories, actor: Actor, executionId: string) {
  const record = await requireExecution(repos, actor, executionId);
  return toStatusDto(record, await hasFeedback(repos, record.executionId));
}

export async function listExecutions(repos: Repositories, actor: Actor, query: ExecutionQuery) {
  const installationId = actor.kind === 'installation' ? actor.installationId : query.installationId;
  if (!installationId) throw new AppError(400, 'validation_error', 'installationId is required');
  if (actor.kind === 'installation' && query.installationId && query.installationId !== actor.installationId) {
    throw new AppError(404, 'not_found', 'Installation not found');
  }
  const page = await repos.executions.query({ ...query, installationId });
  const items = page.items.map((record) => {
    const item = toQueueItem(record);
    if (actor.kind === 'installation') return { ...item, assignedReviewerId: null };
    return item;
  });
  return { items, nextCursor: page.nextCursor };
}

export async function listQueue(repos: Repositories, query: ExecutionQuery) {
  const page = await repos.executions.query(query);
  return { items: page.items.map(toQueueItem), nextCursor: page.nextCursor };
}

export async function updateExecution(config: AppConfig, repos: Repositories, installationId: string, executionId: string, body: unknown, ip: string | undefined) {
  const parsed = parseBody(executionUpdateSchema, body);
  assertNoCredentialKeys(parsed);
  const redacted = redactSecrets(parsed);
  const patch = redacted.value as ExecutionUpdate;
  const existing = await repos.executions.get(executionId);
  if (!existing || existing.installationId !== installationId) throw new AppError(404, 'not_found', 'Execution not found');
  const updated = await withExecution(repos, executionId, (draft) => {
    if (draft.installationId !== installationId) throw new AppError(404, 'not_found', 'Execution not found');
    applyPatch(config, draft, patch);
    draft.updateLogEnc = [...draft.updateLogEnc, encryptString(config.dataEncryptionKey, canonicalStringify({ at: new Date().toISOString(), patch }))].slice(-20);
    draft.supplementalUpdatedAt = new Date().toISOString();
    if (draft.reviewStatus === 'needs_more_information') {
      draft.reviewStatus = 'pending';
      draft.assignedReviewerId = undefined;
    }
    if (draft.reviewStatus === 'completed') draft.updatedAfterReview = true;
    if (redacted.findings.length > 0) draft.secretFindings = [...draft.secretFindings, ...redacted.findings].slice(-100);
    draft.searchText = searchText(draft);
    trimToSize(draft);
    return draft;
  });
  await writeAudit(repos, { kind: 'installation', installationId }, 'execution.updated', 'execution', executionId, ip, { revision: String(updated.revision) });
  return { execution: toExecutionDto(config, updated, 'customer') };
}

function applyPatch(config: AppConfig, draft: ExecutionRecord, patch: ExecutionUpdate): void {
  if (patch.ai) {
    if (patch.ai.requestSummary !== undefined) draft.requestSummary = patch.ai.requestSummary;
    if (patch.ai.changeSummary !== undefined) draft.changeSummary = patch.ai.changeSummary;
  }
  if (patch.codeChange) {
    if (patch.codeChange.filesChanged) draft.filesChanged = patch.codeChange.filesChanged;
    if (patch.codeChange.pullRequest === null) draft.pullRequest = undefined;
    else if (patch.codeChange.pullRequest) draft.pullRequest = patch.codeChange.pullRequest;
    if (patch.codeChange.commits) draft.commits = patch.codeChange.commits;
  }
  if (patch.operationalNotes === null) draft.operationalNotesEnc = undefined;
  else if (patch.operationalNotes !== undefined) draft.operationalNotesEnc = encryptOptional(config.dataEncryptionKey, patch.operationalNotes);
  if (patch.errors) draft.errors = patch.errors;
  if (patch.warnings) draft.warnings = patch.warnings;
  if (patch.outcome) {
    draft.outcomeStatus = patch.outcome.status;
    draft.outcomeSummary = patch.outcome.summary;
  }
  if (patch.completedAt === null) draft.completedAt = undefined;
  else if (patch.completedAt) draft.completedAt = patch.completedAt;
  if (patch.metadata) draft.metadata = { ...draft.metadata, ...patch.metadata };
}

function toStoredExecution(
  config: AppConfig,
  upload: ExecutionUpload,
  installationId: string,
  installationName: string,
  contentHash: string,
  findings: SecretFinding[],
): ExecutionRecord {
  const now = new Date().toISOString();
  const record: ExecutionRecord = {
    executionId: upload.executionId,
    installationId,
    installationName,
    schemaVersion: upload.schemaVersion,
    contentHash,
    reviewStatus: 'pending',
    processingStatus: 'ready_for_review',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    updatedAfterReview: false,
    repositoryKey: repositoryKeyOf(upload.repository.owner, upload.repository.name),
    repositoryName: upload.repository.name,
    repositoryOwner: upload.repository.owner ?? '',
    repositoryHost: upload.repository.host,
    repositoryUrl: upload.repository.url,
    defaultBranch: upload.repository.defaultBranch,
    issueTitle: upload.githubIssue.title,
    issueNumber: upload.githubIssue.number,
    issueUrl: upload.githubIssue.url,
    issueBodyEnc: encryptString(config.dataEncryptionKey, upload.githubIssue.body),
    issueLabels: upload.githubIssue.labels ?? [],
    promptId: upload.prompt.promptId,
    effectivePromptEnc: encryptString(config.dataEncryptionKey, upload.prompt.effectivePrompt),
    systemPromptEnc: encryptOptional(config.dataEncryptionKey, upload.prompt.systemPrompt),
    provider: upload.ai.provider,
    model: upload.ai.model,
    requestSummary: upload.ai.requestSummary,
    changeSummary: upload.ai.changeSummary,
    operationalNotesEnc: encryptOptional(config.dataEncryptionKey, upload.operationalNotes),
    filesChanged: upload.codeChange.filesChanged,
    pullRequest: upload.codeChange.pullRequest,
    commits: upload.codeChange.commits ?? [],
    errors: upload.errors ?? [],
    warnings: upload.warnings ?? [],
    outcomeStatus: upload.outcome.status,
    outcomeSummary: upload.outcome.summary,
    startedAt: upload.startedAt,
    completedAt: upload.completedAt,
    metadata: upload.metadata ?? {},
    secretFindings: findings,
    rawPayloadEnc: encryptString(config.dataEncryptionKey, canonicalStringify(upload)),
    updateLogEnc: [],
    searchText: '',
  };
  record.searchText = searchText(record);
  return record;
}

function searchText(record: ExecutionRecord): string {
  return [
    record.executionId,
    record.installationId,
    record.installationName,
    record.repositoryKey,
    record.issueTitle,
    record.issueNumber ?? '',
    record.provider,
    record.model,
    record.outcomeStatus,
    record.promptId ?? '',
  ].join(' ').toLowerCase();
}

async function requireExecution(repos: Repositories, actor: Actor, executionId: string): Promise<ExecutionRecord> {
  const record = await repos.executions.get(executionId);
  if (!record) throw new AppError(404, 'not_found', 'Execution not found');
  if (actor.kind === 'installation' && actor.installationId !== record.installationId) {
    throw new AppError(404, 'not_found', 'Execution not found');
  }
  return record;
}

async function linkedReview(repos: Repositories, reviewId: string | undefined) {
  if (!reviewId) return null;
  return repos.reviews.get(reviewId);
}

async function hasFeedback(repos: Repositories, executionId: string): Promise<boolean> {
  const reviews = await repos.reviews.listByExecution(executionId);
  return reviews.some((review) => Boolean(review.published));
}

function findingMetadata(findings: SecretFinding[]): Record<string, string> | undefined {
  if (findings.length === 0) return undefined;
  return {
    findings: String(findings.length),
    types: [...new Set(findings.map((finding) => finding.type))].join(','),
  };
}

function assertItemSize(record: ExecutionRecord): void {
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_ITEM_BYTES) {
    throw new AppError(413, 'payload_too_large', 'Execution exceeds the stored item size limit');
  }
}

function trimToSize(record: ExecutionRecord): void {
  while (Buffer.byteLength(JSON.stringify(record)) > MAX_ITEM_BYTES && record.updateLogEnc.length > 0) {
    record.updateLogEnc.shift();
  }
  assertItemSize(record);
}
