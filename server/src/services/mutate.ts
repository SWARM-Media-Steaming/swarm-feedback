import { AppError } from '../errors.js';
import type { ExecutionRecord } from '../records.js';
import type { Repositories } from '../repos/types.js';

export async function withExecution(
  repos: Repositories,
  executionId: string,
  mutator: (draft: ExecutionRecord) => ExecutionRecord | Promise<ExecutionRecord>,
): Promise<ExecutionRecord> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await repos.executions.get(executionId);
    if (!current) throw new AppError(404, 'not_found', 'Execution not found');
    const next = await mutator(structuredClone(current));
    next.revision = current.revision + 1;
    next.updatedAt = new Date().toISOString();
    const saved = await repos.executions.compareAndSwap(current.revision, next);
    if (saved) return next;
  }
  throw new AppError(409, 'execution_conflict', 'Execution was updated concurrently');
}
