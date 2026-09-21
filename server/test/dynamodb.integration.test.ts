import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { connectDynamo } from '../src/repos/dynamo.js';
import { uploadExecution } from '../src/services/executions.js';
import { createInstallation } from '../src/services/installations.js';
import { listFeedback, submitReview } from '../src/services/reviews.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000';
const prefix = `it${Date.now()}_`;

describe('dynamodb local', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-jwt-secret-should-be-long-enough',
    DATA_ENCRYPTION_KEY_HEX: 'cd'.repeat(32),
    SEED_DEMO: 'false',
    BOOTSTRAP_TOKEN: '',
    DYNAMODB_ENDPOINT: endpoint,
    DYNAMODB_TABLE_PREFIX: prefix,
    DYNAMODB_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'local',
    AWS_SECRET_ACCESS_KEY: 'local',
  });
  const dynamo = connectDynamo(config);

  beforeAll(async () => {
    await dynamo.migrate();
  });

  afterAll(async () => {
    await dynamo.dropAll();
  });

  it('stores an execution in queryable columns and encrypts the prompt', async () => {
    const created = await createInstallation(dynamo.repos, { kind: 'system', id: 'test' }, { name: 'Dynamo Plant' }, '127.0.0.1');
    const executionId = randomUUID();
    const uploaded = await uploadExecution(config, dynamo.repos, created.installation.installationId, {
      executionId,
      githubIssue: { title: 'Queue filter', body: 'Show pending work.' },
      prompt: { effectivePrompt: 'Add a status filter to the review queue.' },
      ai: { provider: 'spacexai', model: 'grok-4', changeSummary: 'Added the filter.' },
      repository: { owner: 'acme', name: 'widget' },
      codeChange: { filesChanged: [{ path: 'src/queue.ts', changeType: 'modified' }] },
      outcome: { status: 'success' },
    }, '127.0.0.1');
    expect(uploaded.duplicate).toBe(false);

    const again = await uploadExecution(config, dynamo.repos, created.installation.installationId, {
      executionId,
      githubIssue: { title: 'Queue filter', body: 'Show pending work.' },
      prompt: { effectivePrompt: 'Add a status filter to the review queue.' },
      ai: { provider: 'spacexai', model: 'grok-4', changeSummary: 'Added the filter.' },
      repository: { owner: 'acme', name: 'widget' },
      codeChange: { filesChanged: [{ path: 'src/queue.ts', changeType: 'modified' }] },
      outcome: { status: 'success' },
    }, '127.0.0.1');
    expect(again.duplicate).toBe(true);

    const queued = await dynamo.repos.executions.query({
      reviewStatus: 'pending',
      repositoryKey: 'acme/widget',
      q: 'queue filter',
      limit: 10,
    });
    expect(queued.items.map((item) => item.executionId)).toContain(executionId);
    const stored = queued.items.find((item) => item.executionId === executionId);
    expect(stored?.effectivePromptEnc.startsWith('enc:v1:')).toBe(true);
    expect(stored?.rawPayloadEnc.startsWith('enc:v1:')).toBe(true);
    const scores = {
      promptClarity: 4,
      promptCompleteness: 4,
      contextQuality: 4,
      technicalSpecificity: 4,
      constraintQuality: 4,
      intentUnderstanding: 4,
      implementationQuality: 4,
      efficiency: 4,
      overallPromptQuality: 4,
    };
    await submitReview(config, dynamo.repos, {
      kind: 'user',
      userId: 'reviewer-1',
      role: 'reviewer',
      email: 'reviewer@example.com',
      name: 'Reviewer',
    }, executionId, { scores, recommendedImprovedPrompt: 'Name the file to edit.' }, '127.0.0.1');
    const feedback = await listFeedback(config, dynamo.repos, {
      kind: 'installation',
      installationId: created.installation.installationId,
    }, { installationId: created.installation.installationId, executionId, limit: 10 });
    expect(feedback.items).toHaveLength(1);
    expect(feedback.items[0]?.recommendedImprovedPrompt).toBe('Name the file to edit.');
    expect(await dynamo.repos.health.ready()).toBe(true);
  });
});
