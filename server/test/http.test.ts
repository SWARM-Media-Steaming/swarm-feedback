import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMemoryRepositories } from '../src/repos/memory.js';
import { recordAutomatedEvaluation } from '../src/services/reviews.js';
import { hashPassword } from '../src/security.js';

const keyHex = 'ab'.repeat(32);

function executionBody(executionId = randomUUID(), title = 'Fix the parser') {
  return {
    executionId,
    githubIssue: {
      url: 'https://github.com/acme/widget/issues/12',
      number: 12,
      title,
      body: 'The parser drops the last token.',
      labels: ['bug'],
    },
    prompt: {
      promptId: 'prompt-1',
      effectivePrompt: 'Fix the parser so the last token is preserved. Do not refactor unrelated files.',
      systemPrompt: 'You are a careful coding agent.',
    },
    ai: {
      provider: 'spacexai',
      model: 'grok-4',
      requestSummary: 'Repair the token parser.',
      changeSummary: 'Preserved the trailing token in the scanner.',
    },
    repository: {
      host: 'github.com',
      owner: 'Acme',
      name: 'Widget',
      url: 'https://github.com/acme/widget',
      defaultBranch: 'main',
    },
    codeChange: {
      filesChanged: [{ path: 'src/parser.ts', changeType: 'modified', additions: 4, deletions: 1 }],
      pullRequest: { number: 40, url: 'https://github.com/acme/widget/pull/40', title: 'Fix parser', state: 'open' },
      commits: [{ sha: '0123456789abcdef0123456789abcdef01234567', message: 'Fix parser' }],
    },
    operationalNotes: 'Ran the unit tests.',
    warnings: [{ message: 'Snapshot was noisy' }],
    outcome: { status: 'success', summary: 'Parser keeps the last token.' },
    metadata: { source: 'swarm' },
  };
}

const scores = {
  promptClarity: 4,
  promptCompleteness: 3,
  contextQuality: 4,
  technicalSpecificity: 5,
  constraintQuality: 4,
  intentUnderstanding: 4,
  implementationQuality: 5,
  efficiency: 3,
  overallPromptQuality: 4,
};

describe('http api', () => {
  let app: FastifyInstance;
  const repos = createMemoryRepositories();
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-jwt-secret-should-be-long-enough',
    DATA_ENCRYPTION_KEY_HEX: keyHex,
    SEED_DEMO: 'false',
    BOOTSTRAP_TOKEN: 'test-bootstrap-token',
    GLOBAL_RATE_MAX: '10000',
    UPLOAD_RATE_MAX: '10000',
    LOGIN_RATE_MAX: '10000',
    DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
  });

  beforeAll(async () => {
    await repos.users.create({
      userId: randomUUID(),
      email: 'admin@example.com',
      name: 'Ada Admin',
      role: 'administrator',
      passwordHash: await hashPassword('admin-password-1'),
      disabled: false,
      createdAt: new Date().toISOString(),
    });
    await repos.users.create({
      userId: randomUUID(),
      email: 'reviewer@example.com',
      name: 'Rita Reviewer',
      role: 'reviewer',
      passwordHash: await hashPassword('reviewer-password-1'),
      disabled: false,
      createdAt: new Date().toISOString(),
    });
    app = await buildApp(config, repos);
  });

  afterAll(async () => {
    await app.close();
  });

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    expect(response.statusCode).toBe(200);
    return response.json().token as string;
  }

  it('isolates installations and completes the review feedback loop', async () => {
    const adminToken = await login('admin@example.com', 'admin-password-1');
    const reviewerToken = await login('reviewer@example.com', 'reviewer-password-1');

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { email: 'new@example.com', name: 'New', password: 'reviewer-password-1', role: 'reviewer' },
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/installations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Plant A', contactEmail: 'owner-a@example.com' },
    });
    expect(created.statusCode).toBe(200);
    const keyA = created.json().apiKey as string;
    const installationA = created.json().installation.installationId as string;

    const boot = await app.inject({
      method: 'POST',
      url: '/api/v1/installations/register',
      headers: { 'x-bootstrap-token': 'test-bootstrap-token' },
      payload: { name: 'Plant B' },
    });
    expect(boot.statusCode).toBe(200);
    const keyB = boot.json().apiKey as string;

    const badBoot = await app.inject({
      method: 'POST',
      url: '/api/v1/installations/register',
      headers: { 'x-bootstrap-token': 'nope' },
      payload: { name: 'Plant C' },
    });
    expect(badBoot.statusCode).toBe(401);

    const payload = executionBody();
    payload.prompt.effectivePrompt += ' ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: { authorization: `Bearer ${keyA}` },
      payload,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().duplicate).toBe(false);
    const executionId = payload.executionId;

    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: { authorization: `Bearer ${keyA}` },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().duplicate).toBe(true);

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: { authorization: `Bearer ${keyA}` },
      payload: { ...payload, githubIssue: { ...payload.githubIssue, title: 'Different title' } },
    });
    expect(conflict.statusCode).toBe(409);

    const other = await app.inject({
      method: 'GET',
      url: `/api/v1/executions/${executionId}`,
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(other.statusCode).toBe(404);

    const queueDenied = await app.inject({
      method: 'GET',
      url: '/api/v1/review-queue',
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(queueDenied.statusCode).toBe(401);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/executions/${executionId}`,
      headers: { authorization: `Bearer ${reviewerToken}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().execution.prompt.effectivePrompt).toContain('[REDACTED:github_token]');
    expect(detail.json().execution.prompt.effectivePrompt).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(detail.json().execution.repository.key).toBe('acme/widget');
    expect(detail.json().execution.secretFindings.length).toBeGreaterThan(0);

    const queue = await app.inject({
      method: 'GET',
      url: '/api/v1/review-queue?status=pending&repository=acme/widget&q=parser',
      headers: { authorization: `Bearer ${reviewerToken}` },
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().items.some((item: { executionId: string }) => item.executionId === executionId)).toBe(true);

    const credential = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: { authorization: `Bearer ${keyA}` },
      payload: { ...executionBody(), apiKey: 'should-not-upload' },
    });
    expect(credential.statusCode).toBe(400);

    const needs = await app.inject({
      method: 'POST',
      url: `/api/v1/executions/${executionId}/review/needs-information`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { missingInformation: 'Which parser grammar is authoritative?' },
    });
    expect(needs.statusCode).toBe(200);

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/feedback?executionId=${executionId}`,
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().items).toEqual([]);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/executions/${executionId}`,
      headers: { authorization: `Bearer ${keyA}` },
      payload: { operationalNotes: 'Grammar is docs/grammar.md.' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().execution.reviewStatus).toBe('pending');
    expect(patched.json().execution.operationalNotes).toBe('Grammar is docs/grammar.md.');

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/executions/${executionId}/status`,
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(status.json()).toMatchObject({ processingStatus: 'ready_for_review', reviewStatus: 'pending', feedbackAvailable: false });

    const draft = await app.inject({
      method: 'PUT',
      url: `/api/v1/executions/${executionId}/review`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { whatWasDoneWell: 'The prompt named the bug.', scores: { promptClarity: 4 } },
    });
    expect(draft.statusCode).toBe(200);

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/executions/${executionId}/review/submit`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        scores,
        whatWasDoneWell: 'The prompt named the bug and the expected behavior.',
        missingInformation: 'It did not name the grammar file.',
        ambiguous: '“Last token” could mean whitespace.',
        couldBeWrittenBetter: 'Point at the grammar and the test to update.',
        recommendedImprovedPrompt: 'Update src/parser.ts so the final token is kept. Use docs/grammar.md. Add a regression test. Do not edit unrelated packages.',
        generalComments: 'Strong bug report, light on file pointers.',
      },
    });
    expect(submitted.statusCode).toBe(200);
    const feedback = submitted.json();
    expect(feedback.overallScore).toBe(4);
    expect(feedback.scoreAverage).toBeGreaterThan(3);
    expect(feedback.reviewVersion).toBe(1);
    expect(feedback.recommendedImprovedPrompt).toContain('docs/grammar.md');
    expect(feedback.feedbackDeliveryStatus).toBe('available');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/feedback?deliveryStatus=available',
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(listed.json().items).toHaveLength(1);

    const leaked = await app.inject({
      method: 'GET',
      url: `/api/v1/feedback/${feedback.reviewId}`,
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(leaked.statusCode).toBe(404);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/feedback/${feedback.reviewId}/acknowledgements`,
      headers: { authorization: `Bearer ${keyA}` },
      payload: { reviewVersion: 9 },
    });
    expect(stale.statusCode).toBe(409);

    const ack = await app.inject({
      method: 'POST',
      url: `/api/v1/feedback/${feedback.reviewId}/acknowledgements`,
      headers: { authorization: `Bearer ${keyA}` },
      payload: { reviewVersion: 1 },
    });
    expect(ack.statusCode).toBe(200);
    const ackAgain = await app.inject({
      method: 'POST',
      url: `/api/v1/feedback/${feedback.reviewId}/acknowledgements`,
      headers: { authorization: `Bearer ${keyA}` },
      payload: { reviewVersion: 1 },
    });
    expect(ackAgain.statusCode).toBe(200);
    expect(ackAgain.json().feedbackDeliveryStatus).toBe('acknowledged');

    const automated = await recordAutomatedEvaluation(config, repos, {
      executionId,
      evaluatorModel: 'future-evaluator',
      scores: { ...scores, overallPromptQuality: 3 },
      generalComments: 'Automated pass.',
      recommendedImprovedPrompt: 'Be explicit about the grammar file.',
    });
    expect(automated.evaluatorType).toBe('automated');
    const both = await app.inject({
      method: 'GET',
      url: `/api/v1/feedback?executionId=${executionId}`,
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(both.json().items).toHaveLength(2);
    const humans = await app.inject({
      method: 'GET',
      url: `/api/v1/feedback?executionId=${executionId}&evaluatorType=human`,
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(humans.json().items).toHaveLength(1);

    const batch = await app.inject({
      method: 'POST',
      url: '/api/v1/executions/batch',
      headers: { authorization: `Bearer ${keyA}` },
      payload: { executions: [executionBody(), { executionId: 'not-a-uuid' }, payload] },
    });
    expect(batch.statusCode).toBe(200);
    const batchResults = batch.json().results as Array<{ status: string }>;
    expect(batchResults.map((item) => item.status)).toEqual(['created', 'error', 'duplicate']);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items.length).toBeGreaterThan(0);
    const reviewerAudit = await app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { authorization: `Bearer ${reviewerToken}` },
    });
    expect(reviewerAudit.statusCode).toBe(403);

    const rotated = await app.inject({
      method: 'POST',
      url: `/api/v1/installations/${installationA}/rotate-key`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(rotated.statusCode).toBe(200);
    const oldKey = await app.inject({
      method: 'GET',
      url: '/api/v1/executions',
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(oldKey.statusCode).toBe(401);
    const newKey = rotated.json().apiKey as string;
    const stillThere = await app.inject({
      method: 'GET',
      url: `/api/v1/executions/${executionId}/status`,
      headers: { authorization: `Bearer ${newKey}` },
    });
    expect(stillThere.statusCode).toBe(200);
  });

  it('rejects an unauthenticated upload', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/executions', payload: executionBody() });
    expect(response.statusCode).toBe(401);
  });
});
