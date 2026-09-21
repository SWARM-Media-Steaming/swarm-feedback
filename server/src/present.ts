import type { AppConfig } from './config.js';
import { scoreAverage } from './domain.js';
import type { ExecutionRecord, InstallationRecord, ReviewRecord, UserRecord } from './records.js';
import { decryptString } from './security.js';

function text(key: Buffer, value: string | undefined): string {
  return value ? decryptString(key, value) : '';
}

export function toExecutionDto(config: AppConfig, record: ExecutionRecord, audience: 'reviewer' | 'customer') {
  return {
    executionId: record.executionId,
    installationId: record.installationId,
    installationName: record.installationName,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    reviewStatus: record.reviewStatus,
    processingStatus: record.processingStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    supplementalUpdatedAt: record.supplementalUpdatedAt ?? null,
    updatedAfterReview: record.updatedAfterReview,
    assignedReviewerId: audience === 'reviewer' ? record.assignedReviewerId ?? null : undefined,
    secretFindings: record.secretFindings,
    githubIssue: {
      title: record.issueTitle,
      body: text(config.dataEncryptionKey, record.issueBodyEnc),
      number: record.issueNumber ?? null,
      url: record.issueUrl ?? null,
      labels: record.issueLabels,
    },
    prompt: {
      promptId: record.promptId ?? null,
      effectivePrompt: text(config.dataEncryptionKey, record.effectivePromptEnc),
      systemPrompt: record.systemPromptEnc ? decryptString(config.dataEncryptionKey, record.systemPromptEnc) : null,
    },
    ai: {
      provider: record.provider,
      model: record.model,
      requestSummary: record.requestSummary ?? null,
      changeSummary: record.changeSummary ?? null,
    },
    repository: {
      key: record.repositoryKey,
      name: record.repositoryName,
      owner: record.repositoryOwner || null,
      host: record.repositoryHost ?? null,
      url: record.repositoryUrl ?? null,
      defaultBranch: record.defaultBranch ?? null,
    },
    codeChange: {
      filesChanged: record.filesChanged,
      pullRequest: record.pullRequest ?? null,
      commits: record.commits,
    },
    operationalNotes: record.operationalNotesEnc ? decryptString(config.dataEncryptionKey, record.operationalNotesEnc) : null,
    errors: record.errors,
    warnings: record.warnings,
    outcome: {
      status: record.outcomeStatus,
      summary: record.outcomeSummary ?? null,
    },
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    metadata: record.metadata,
  };
}

export function toQueueItem(record: ExecutionRecord) {
  return {
    executionId: record.executionId,
    installationId: record.installationId,
    installationName: record.installationName,
    reviewStatus: record.reviewStatus,
    processingStatus: record.processingStatus,
    repositoryKey: record.repositoryKey,
    repositoryName: record.repositoryName,
    issueTitle: record.issueTitle,
    issueNumber: record.issueNumber ?? null,
    provider: record.provider,
    model: record.model,
    outcomeStatus: record.outcomeStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    assignedReviewerId: record.assignedReviewerId ?? null,
    secretFindingCount: record.secretFindings.length,
    supplementalUpdatedAt: record.supplementalUpdatedAt ?? null,
  };
}

export function toReviewDto(config: AppConfig, review: ReviewRecord) {
  return {
    reviewId: review.reviewId,
    executionId: review.executionId,
    installationId: review.installationId,
    reviewerId: review.reviewerId,
    evaluatorType: review.evaluatorType,
    evaluatorModel: review.evaluatorModel ?? null,
    scoreSchemaVersion: review.scoreSchemaVersion,
    status: review.status,
    scores: review.scores,
    whatWasDoneWell: review.whatWasDoneWell ?? '',
    missingInformation: review.missingInformation ?? '',
    ambiguous: review.ambiguous ?? '',
    couldBeWrittenBetter: review.couldBeWrittenBetter ?? '',
    recommendedImprovedPrompt: text(config.dataEncryptionKey, review.recommendedImprovedPromptEnc),
    generalComments: review.generalComments ?? '',
    version: review.version,
    feedbackDeliveryStatus: review.feedbackDeliveryStatus,
    submittedAt: review.submittedAt ?? null,
    updatedAt: review.updatedAt,
    createdAt: review.createdAt,
    history: review.history,
  };
}

export function toFeedbackDto(config: AppConfig, review: ReviewRecord) {
  if (!review.published) return null;
  const published = review.published;
  return {
    executionId: review.executionId,
    reviewId: review.reviewId,
    scores: published.scores,
    overallScore: published.scores.overallPromptQuality,
    scoreAverage: scoreAverage(published.scores),
    comments: published.generalComments,
    deficiencies: {
      missingInformation: published.missingInformation,
      ambiguous: published.ambiguous,
      couldHaveBeenWrittenBetter: published.couldBeWrittenBetter,
    },
    recommendations: published.couldBeWrittenBetter,
    whatWasDoneWell: published.whatWasDoneWell,
    recommendedImprovedPrompt: text(config.dataEncryptionKey, published.recommendedImprovedPromptEnc),
    reviewerTimestamp: published.submittedAt,
    reviewVersion: published.version,
    feedbackDeliveryStatus: review.feedbackDeliveryStatus,
    evaluatorType: review.evaluatorType,
    evaluatorModel: review.evaluatorModel ?? null,
  };
}

export function toStatusDto(record: ExecutionRecord, feedbackAvailable: boolean) {
  return {
    executionId: record.executionId,
    uploadStatus: 'accepted' as const,
    processingStatus: record.processingStatus,
    reviewStatus: record.reviewStatus,
    feedbackAvailable,
    revision: record.revision,
    receivedAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toPublicInstallation(record: InstallationRecord, admin: boolean) {
  return {
    installationId: record.installationId,
    name: record.name,
    status: record.status,
    contactEmail: admin ? record.contactEmail ?? null : undefined,
    apiKeyPrefix: admin ? record.apiKeyPrefix : undefined,
    createdAt: admin ? record.createdAt : undefined,
    updatedAt: admin ? record.updatedAt : undefined,
  };
}

export function toPublicUser(record: UserRecord) {
  return {
    userId: record.userId,
    email: record.email,
    name: record.name,
    role: record.role,
    disabled: record.disabled,
    createdAt: record.createdAt,
  };
}
