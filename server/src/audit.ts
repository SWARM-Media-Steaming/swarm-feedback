import { randomUUID } from 'node:crypto';
import type { Actor } from './actors.js';
import type { Repositories } from './repos/types.js';

export type AuditActor = Actor | { kind: 'system'; id: string };

export async function writeAudit(
  repos: Repositories,
  actor: AuditActor,
  action: string,
  resourceType: string,
  resourceId: string,
  ip: string | undefined,
  metadata?: Record<string, string>,
): Promise<void> {
  const createdAt = new Date().toISOString();
  try {
    await repos.audit.put({
      auditId: randomUUID(),
      day: createdAt.slice(0, 10),
      createdAt,
      actorType: actor.kind === 'user' ? 'user' : actor.kind === 'installation' ? 'installation' : 'system',
      actorId: actor.kind === 'user' ? actor.userId : actor.kind === 'installation' ? actor.installationId : actor.id,
      action,
      resourceType,
      resourceId,
      outcome: 'success',
      ip,
      metadata,
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.error('audit write failed', error instanceof Error ? error.message : 'unknown');
    }
  }
}
