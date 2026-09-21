import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { UserActor } from '../actors.js';
import type { Actor } from '../actors.js';
import { writeAudit } from '../audit.js';
import {
  automatedEvaluationSchema,
  isCompleteScores,
  needsInfoSchema,
  parseBody,
  reviewDraftSchema,
  reviewSubmitSchema,
  type Scores,
} from '../domain.js';
import { AppError } from '../errors.js';
import { toFeedbackDto, toReviewDto } from '../present.js';
import type { ExecutionRecord, FeedbackQuery, PublishedReview, ReviewRecord } from '../records.js';
import type { Repositories } from '../repos/types.js';
import { encryptOptional, redactSecrets } from '../security.js';
import { withExecution } from './mutate.js';

type Narrative = {
  whatWasDoneWell?: string;
  missingInformation?: string;
  ambiguous?: string;
  couldBeWrittenBetter?: string;
  recommendedImprovedPrompt?: string;
  generalComments?: string;
};

export async function claimExecution(repos: Repositories, actor: UserActor, executionId: string, ip: string | undefined) {
  const updated = await withExecution(repos, executionId, (draft) => {
    assertCanTake(draft, actor);
    if (draft.reviewStatus === 'completed') throw new AppError(409, 'review_conflict', 'Completed executions cannot be claimed');
    draft.reviewStatus = 'in_review';
    draft.assignedReviewerId = actor.userId;
    return draft;
  });
  await writeAudit(repos, actor, 'review.claimed', 'execution', executionId, ip);
  return { executionId: updated.executionId, reviewStatus: updated.reviewStatus, assignedReviewerId: updated.assignedReviewerId ?? null };
}

export async function releaseExecution(repos: Repositories, actor: UserActor, executionId: string, ip: string | undefined) {
  const updated = await withExecution(repos, executionId, (draft) => {
    if (draft.reviewStatus !== 'in_review') throw new AppError(409, 'review_conflict', 'Execution is not in review');
    if (draft.assignedReviewerId !== actor.userId && actor.role !== 'administrator') {
      throw new AppError(403, 'forbidden', 'Only the assigned reviewer can release this execution');
    }
    draft.reviewStatus = 'pending';
    draft.assignedReviewerId = undefined;
    return draft;
  });
  await writeAudit(repos, actor, 'review.released', 'execution', executionId, ip);
  return { executionId: updated.executionId, reviewStatus: updated.reviewStatus };
}

export async function saveDraft(config: AppConfig, repos: Repositories, actor: UserActor, executionId: string, body: unknown, ip: string | undefined) {
  const input = redactNarrative(parseBody(reviewDraftSchema, body));
  const execution = await requireVisible(repos, executionId);
  const review = await ensureHumanReview(repos, execution, actor);
  applyNarrative(config, review, input, input.scores);
  if (review.status !== 'submitted') review.status = 'draft';
  review.updatedAt = new Date().toISOString();
  await repos.reviews.save(review);
  if (execution.reviewStatus !== 'completed') await assignInReview(repos, executionId, actor);
  await writeAudit(repos, actor, 'review.draft_saved', 'review', review.reviewId, ip);
  return toReviewDto(config, review);
}

export async function submitReview(config: AppConfig, repos: Repositories, actor: UserActor, executionId: string, body: unknown, ip: string | undefined) {
  const input = redactNarrative(parseBody(reviewSubmitSchema, body));
  const execution = await requireVisible(repos, executionId);
  if (execution.reviewStatus !== 'completed') assertCanTake(execution, actor);
  const review = await ensureHumanReview(repos, execution, actor);
  applyNarrative(config, review, input, input.scores);
  publish(config, review, actor.userId, input.scores);
  await repos.reviews.save(review);
  await withExecution(repos, executionId, (draft) => {
    draft.reviewStatus = 'completed';
    draft.assignedReviewerId = actor.userId;
    draft.reviewId = review.reviewId;
    return draft;
  });
  await writeAudit(repos, actor, 'review.submitted', 'review', review.reviewId, ip, { reviewVersion: String(review.version) });
  const feedback = toFeedbackDto(config, review);
  if (!feedback) throw new AppError(500, 'internal_error', 'Review did not publish');
  return feedback;
}

export async function markNeedsInformation(config: AppConfig, repos: Repositories, actor: UserActor, executionId: string, body: unknown, ip: string | undefined) {
  const input = redactNarrative(parseBody(needsInfoSchema, body));
  const execution = await requireVisible(repos, executionId);
  if (execution.reviewStatus === 'completed') {
    throw new AppError(409, 'review_conflict', 'Completed reviews stay published. Submit a new review version instead.');
  }
  assertCanTake(execution, actor);
  const review = await ensureHumanReview(repos, execution, actor);
  review.missingInformation = input.missingInformation;
  if (input.generalComments !== undefined) review.generalComments = input.generalComments;
  review.status = 'needs_more_information';
  review.feedbackDeliveryStatus = review.published ? review.feedbackDeliveryStatus : 'not_ready';
  review.updatedAt = new Date().toISOString();
  review.reviewerId = actor.userId;
  await repos.reviews.save(review);
  await withExecution(repos, executionId, (draft) => {
    if (draft.reviewStatus === 'completed') throw new AppError(409, 'review_conflict', 'Completed reviews stay published');
    draft.reviewStatus = 'needs_more_information';
    draft.assignedReviewerId = actor.userId;
    draft.reviewId = review.reviewId;
    return draft;
  });
  await writeAudit(repos, actor, 'review.needs_information', 'review', review.reviewId, ip);
  return toReviewDto(config, review);
}

export async function listFeedback(config: AppConfig, repos: Repositories, actor: Actor, query: FeedbackQuery) {
  const installationId = actor.kind === 'installation' ? actor.installationId : query.installationId;
  if (actor.kind === 'installation' && query.installationId && query.installationId !== actor.installationId) {
    throw new AppError(404, 'not_found', 'Installation not found');
  }
  const page = await repos.reviews.queryByInstallation({ ...query, installationId });
  return {
    items: page.items.map((review) => toFeedbackDto(config, review)).filter((item) => item !== null),
    nextCursor: page.nextCursor,
  };
}

export async function getFeedback(config: AppConfig, repos: Repositories, actor: Actor, reviewId: string) {
  const review = await repos.reviews.get(reviewId);
  if (!review?.published) throw new AppError(404, 'not_found', 'Feedback not found');
  if (actor.kind === 'installation' && actor.installationId !== review.installationId) {
    throw new AppError(404, 'not_found', 'Feedback not found');
  }
  const feedback = toFeedbackDto(config, review);
  if (!feedback) throw new AppError(404, 'not_found', 'Feedback not found');
  return feedback;
}

export async function acknowledgeFeedback(repos: Repositories, actor: Actor, reviewId: string, reviewVersion: number, ip: string | undefined) {
  const review = await repos.reviews.get(reviewId);
  if (!review?.published) throw new AppError(404, 'not_found', 'Feedback not found');
  if (actor.kind === 'installation' && actor.installationId !== review.installationId) {
    throw new AppError(404, 'not_found', 'Feedback not found');
  }
  if (actor.kind === 'user' && actor.role !== 'administrator') {
    throw new AppError(403, 'forbidden', 'Insufficient role');
  }
  if (review.published.version !== reviewVersion) {
    throw new AppError(409, 'stale_review_version', 'Feedback has a newer version', { currentVersion: review.published.version });
  }
  if (review.feedbackDeliveryStatus === 'acknowledged' && review.acknowledgedVersion === reviewVersion) {
    return acknowledgement(review);
  }
  review.feedbackDeliveryStatus = 'acknowledged';
  review.acknowledgedAt = new Date().toISOString();
  review.acknowledgedVersion = reviewVersion;
  review.updatedAt = review.acknowledgedAt;
  await repos.reviews.save(review);
  await writeAudit(repos, actor, 'feedback.acknowledged', 'review', review.reviewId, ip, { reviewVersion: String(reviewVersion) });
  return acknowledgement(review);
}

export async function recordAutomatedEvaluation(config: AppConfig, repos: Repositories, body: unknown) {
  const input = redactNarrative(parseBody(automatedEvaluationSchema, body));
  const execution = await repos.executions.get(input.executionId);
  if (!execution) throw new AppError(404, 'not_found', 'Execution not found');
  let review = await automatedReview(repos, execution);
  const now = new Date().toISOString();
  if (!review) {
    review = blankReview({
      execution,
      reviewerId: 'automated',
      evaluatorType: 'automated',
      evaluatorModel: input.evaluatorModel,
      now,
    });
    await repos.reviews.create(review);
  }
  review.evaluatorModel = input.evaluatorModel;
  review.reviewerId = 'automated';
  applyNarrative(config, review, input, input.scores);
  publish(config, review, 'automated', input.scores);
  await repos.reviews.save(review);
  await withExecution(repos, execution.executionId, (draft) => {
    draft.automatedReviewId = review!.reviewId;
    return draft;
  });
  await writeAudit(repos, { kind: 'system', id: 'automated' }, 'review.automated_recorded', 'review', review.reviewId, undefined, {
    reviewVersion: String(review.version),
    evaluatorModel: input.evaluatorModel,
  });
  const feedback = toFeedbackDto(config, review);
  if (!feedback) throw new AppError(500, 'internal_error', 'Automated review did not publish');
  return feedback;
}

function publish(config: AppConfig, review: ReviewRecord, reviewerId: string, scores: Scores): void {
  const previous = review.published;
  const version = (previous?.version ?? 0) + 1;
  const submittedAt = new Date().toISOString();
  if (previous) {
    review.history = [
      ...review.history,
      {
        version: previous.version,
        submittedAt: previous.submittedAt,
        reviewerId: previous.reviewerId,
        overallScore: previous.scores.overallPromptQuality,
        evaluatorType: review.evaluatorType,
      },
    ].slice(-20);
  }
  const published: PublishedReview = {
    version,
    scores,
    whatWasDoneWell: review.whatWasDoneWell ?? '',
    missingInformation: review.missingInformation ?? '',
    ambiguous: review.ambiguous ?? '',
    couldBeWrittenBetter: review.couldBeWrittenBetter ?? '',
    recommendedImprovedPromptEnc: review.recommendedImprovedPromptEnc,
    generalComments: review.generalComments ?? '',
    submittedAt,
    reviewerId,
  };
  review.published = published;
  review.version = version;
  review.status = 'submitted';
  review.feedbackDeliveryStatus = 'available';
  review.submittedAt = submittedAt;
  review.updatedAt = submittedAt;
  review.reviewerId = reviewerId;
  void config;
  if (!isCompleteScores(published.scores)) throw new AppError(400, 'validation_error', 'All scores from 1 to 5 are required');
}

function applyNarrative(config: AppConfig, review: ReviewRecord, input: Narrative, scores?: ReviewRecord['scores']): void {
  if (scores) review.scores = { ...review.scores, ...scores };
  if (input.whatWasDoneWell !== undefined) review.whatWasDoneWell = input.whatWasDoneWell;
  if (input.missingInformation !== undefined) review.missingInformation = input.missingInformation;
  if (input.ambiguous !== undefined) review.ambiguous = input.ambiguous;
  if (input.couldBeWrittenBetter !== undefined) review.couldBeWrittenBetter = input.couldBeWrittenBetter;
  if (input.generalComments !== undefined) review.generalComments = input.generalComments;
  if (input.recommendedImprovedPrompt !== undefined) {
    review.recommendedImprovedPromptEnc = encryptOptional(config.dataEncryptionKey, input.recommendedImprovedPrompt);
  }
}

function redactNarrative<T extends Narrative>(input: T): T {
  return redactSecrets(input).value as T;
}

async function ensureHumanReview(repos: Repositories, execution: ExecutionRecord, actor: UserActor): Promise<ReviewRecord> {
  const existing = await humanReview(repos, execution);
  if (existing) return existing;
  const review = blankReview({
    execution,
    reviewerId: actor.userId,
    evaluatorType: 'human',
    now: new Date().toISOString(),
  });
  await repos.reviews.create(review);
  await withExecution(repos, execution.executionId, (draft) => {
    if (!draft.reviewId) draft.reviewId = review.reviewId;
    return draft;
  });
  return review;
}

async function humanReview(repos: Repositories, execution: ExecutionRecord): Promise<ReviewRecord | null> {
  if (execution.reviewId) {
    const linked = await repos.reviews.get(execution.reviewId);
    if (linked?.evaluatorType === 'human') return linked;
  }
  const list = await repos.reviews.listByExecution(execution.executionId);
  return list.find((review) => review.evaluatorType === 'human') ?? null;
}

async function automatedReview(repos: Repositories, execution: ExecutionRecord): Promise<ReviewRecord | null> {
  if (execution.automatedReviewId) {
    const linked = await repos.reviews.get(execution.automatedReviewId);
    if (linked?.evaluatorType === 'automated') return linked;
  }
  const list = await repos.reviews.listByExecution(execution.executionId);
  return list.find((review) => review.evaluatorType === 'automated') ?? null;
}

function blankReview(input: {
  execution: ExecutionRecord;
  reviewerId: string;
  evaluatorType: 'human' | 'automated';
  evaluatorModel?: string;
  now: string;
}): ReviewRecord {
  return {
    reviewId: randomUUID(),
    executionId: input.execution.executionId,
    installationId: input.execution.installationId,
    reviewerId: input.reviewerId,
    evaluatorType: input.evaluatorType,
    evaluatorModel: input.evaluatorModel,
    scoreSchemaVersion: 1,
    status: 'draft',
    scores: {},
    version: 0,
    feedbackDeliveryStatus: 'not_ready',
    createdAt: input.now,
    updatedAt: input.now,
    history: [],
  };
}

async function assignInReview(repos: Repositories, executionId: string, actor: UserActor): Promise<void> {
  await withExecution(repos, executionId, (draft) => {
    if (draft.reviewStatus === 'completed') return draft;
    assertCanTake(draft, actor);
    draft.reviewStatus = 'in_review';
    draft.assignedReviewerId = actor.userId;
    return draft;
  });
}

function assertCanTake(execution: ExecutionRecord, actor: UserActor): void {
  if (execution.reviewStatus === 'in_review' && execution.assignedReviewerId && execution.assignedReviewerId !== actor.userId && actor.role !== 'administrator') {
    throw new AppError(409, 'review_conflict', 'Execution is assigned to another reviewer');
  }
}

async function requireVisible(repos: Repositories, executionId: string): Promise<ExecutionRecord> {
  const execution = await repos.executions.get(executionId);
  if (!execution) throw new AppError(404, 'not_found', 'Execution not found');
  return execution;
}

function acknowledgement(review: ReviewRecord) {
  return {
    reviewId: review.reviewId,
    executionId: review.executionId,
    reviewVersion: review.acknowledgedVersion ?? review.version,
    feedbackDeliveryStatus: review.feedbackDeliveryStatus,
    acknowledgedAt: review.acknowledgedAt ?? null,
  };
}
