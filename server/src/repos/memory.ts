import { AppError } from '../errors.js';
import type {
  AuditRecord,
  ExecutionQuery,
  ExecutionRecord,
  FeedbackQuery,
  InstallationRecord,
  Page,
  ReviewRecord,
  UserRecord,
} from '../records.js';
import type { Repositories } from './types.js';

type Cursor = { at: string; id: string };

export function createMemoryRepositories(): Repositories {
  const installations = new Map<string, InstallationRecord>();
  const users = new Map<string, UserRecord>();
  const executions = new Map<string, ExecutionRecord>();
  const reviews = new Map<string, ReviewRecord>();
  const audits: AuditRecord[] = [];

  return {
    installations: {
      async create(record) {
        installations.set(record.installationId, record);
      },
      async get(id) {
        return installations.get(id) ?? null;
      },
      async list() {
        return [...installations.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },
      async findByPrefix(prefix) {
        return [...installations.values()].filter((item) => item.apiKeyPrefix === prefix);
      },
      async update(record) {
        installations.set(record.installationId, record);
      },
    },
    users: {
      async create(record) {
        users.set(record.userId, record);
      },
      async get(id) {
        return users.get(id) ?? null;
      },
      async findByEmail(email) {
        const normalized = email.toLowerCase();
        return [...users.values()].find((user) => user.email === normalized) ?? null;
      },
      async list() {
        return [...users.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },
    },
    executions: {
      async create(record) {
        if (executions.has(record.executionId)) return 'exists';
        executions.set(record.executionId, record);
        return 'created';
      },
      async get(id) {
        return executions.get(id) ?? null;
      },
      async compareAndSwap(expectedRevision, next) {
        const current = executions.get(next.executionId);
        if (!current || current.revision !== expectedRevision) return false;
        executions.set(next.executionId, next);
        return true;
      },
      async query(params) {
        return paginate(
          [...executions.values()]
            .filter((item) => matchesExecution(item, params))
            .sort(compareCreated),
          params.cursor,
          params.limit,
          (item) => ({ at: item.createdAt, id: item.executionId }),
        );
      },
    },
    reviews: {
      async create(record) {
        if (reviews.has(record.reviewId)) throw new Error('Review already exists');
        reviews.set(record.reviewId, record);
      },
      async get(id) {
        return reviews.get(id) ?? null;
      },
      async save(record) {
        reviews.set(record.reviewId, record);
      },
      async listByExecution(executionId) {
        return [...reviews.values()]
          .filter((review) => review.executionId === executionId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },
      async queryByInstallation(params) {
        return paginate(
          [...reviews.values()]
            .filter((review) => matchesFeedback(review, params))
            .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? '') || b.reviewId.localeCompare(a.reviewId)),
          params.cursor,
          params.limit,
          (review) => ({ at: review.submittedAt ?? '', id: review.reviewId }),
        );
      },
    },
    audit: {
      async put(record) {
        audits.push(record);
      },
      async listRecent(limit) {
        return [...audits].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      },
    },
    health: {
      async ready() {
        return true;
      },
    },
  };
}

function matchesExecution(item: ExecutionRecord, params: ExecutionQuery): boolean {
  if (params.installationId && item.installationId !== params.installationId) return false;
  if (params.reviewStatus && item.reviewStatus !== params.reviewStatus) return false;
  if (params.repositoryKey && item.repositoryKey !== params.repositoryKey) return false;
  if (params.q && !item.searchText.includes(params.q)) return false;
  return true;
}

function matchesFeedback(review: ReviewRecord, params: FeedbackQuery): boolean {
  if (!review.submittedAt || !review.published) return false;
  if (review.installationId !== params.installationId) return false;
  if (params.executionId && review.executionId !== params.executionId) return false;
  if (params.deliveryStatus && review.feedbackDeliveryStatus !== params.deliveryStatus) return false;
  if (params.evaluatorType && review.evaluatorType !== params.evaluatorType) return false;
  return true;
}

function compareCreated(a: { createdAt: string; executionId: string }, b: { createdAt: string; executionId: string }): number {
  const byTime = b.createdAt.localeCompare(a.createdAt);
  if (byTime !== 0) return byTime;
  return b.executionId.localeCompare(a.executionId);
}

function paginate<T>(items: T[], cursor: string | null | undefined, limit: number, keyOf: (item: T) => Cursor): Page<T> {
  let start = 0;
  if (cursor) {
    const parsed = decodeCursor(cursor);
    const index = items.findIndex((item) => {
      const key = keyOf(item);
      return key.at === parsed.at && key.id === parsed.id;
    });
    if (index < 0) throw new AppError(400, 'validation_error', 'Invalid cursor');
    start = index + 1;
  }
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length && slice.length > 0 ? encodeCursor(keyOf(slice[slice.length - 1])) : null;
  return { items: slice, nextCursor: next };
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (!parsed || typeof parsed.at !== 'string' || typeof parsed.id !== 'string') throw new Error('bad');
    return parsed;
  } catch {
    throw new AppError(400, 'validation_error', 'Invalid cursor');
  }
}
