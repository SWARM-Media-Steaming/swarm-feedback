import { randomUUID } from 'node:crypto';
import type { Actor } from '../actors.js';
import { writeAudit, type AuditActor } from '../audit.js';
import { createInstallationSchema, parseBody } from '../domain.js';
import { AppError } from '../errors.js';
import { toPublicInstallation } from '../present.js';
import type { InstallationRecord } from '../records.js';
import type { Repositories } from '../repos/types.js';
import { apiKeyPrefix, generateApiKey, sha256Hex } from '../security.js';

export async function createInstallation(repos: Repositories, actor: AuditActor, body: unknown, ip: string | undefined) {
  const input = parseBody(createInstallationSchema, body);
  const apiKey = generateApiKey();
  const now = new Date().toISOString();
  const record: InstallationRecord = {
    installationId: randomUUID(),
    name: input.name,
    contactEmail: input.contactEmail?.toLowerCase(),
    status: 'active',
    apiKeyHash: sha256Hex(apiKey),
    apiKeyPrefix: apiKeyPrefix(apiKey),
    createdAt: now,
    updatedAt: now,
  };
  await repos.installations.create(record);
  await writeAudit(repos, actor, 'installation.created', 'installation', record.installationId, ip);
  return {
    installation: toPublicInstallation(record, true),
    apiKey,
  };
}

export async function rotateInstallationKey(repos: Repositories, actor: Actor, installationId: string, ip: string | undefined) {
  const record = await requireInstallationAccess(repos, actor, installationId);
  const apiKey = generateApiKey();
  record.apiKeyHash = sha256Hex(apiKey);
  record.apiKeyPrefix = apiKeyPrefix(apiKey);
  record.updatedAt = new Date().toISOString();
  await repos.installations.update(record);
  await writeAudit(repos, actor, 'installation.rotated', 'installation', record.installationId, ip);
  return { installationId: record.installationId, apiKey, apiKeyPrefix: record.apiKeyPrefix };
}

export async function disableInstallation(repos: Repositories, actor: Actor, installationId: string, ip: string | undefined) {
  if (actor.kind !== 'user' || actor.role !== 'administrator') {
    throw new AppError(403, 'forbidden', 'Insufficient role');
  }
  const record = await repos.installations.get(installationId);
  if (!record) throw new AppError(404, 'not_found', 'Installation not found');
  record.status = 'disabled';
  record.updatedAt = new Date().toISOString();
  await repos.installations.update(record);
  await writeAudit(repos, actor, 'installation.disabled', 'installation', record.installationId, ip);
  return toPublicInstallation(record, true);
}

export async function listInstallations(repos: Repositories, admin: boolean) {
  const records = await repos.installations.list();
  return records.map((record) => toPublicInstallation(record, admin));
}

async function requireInstallationAccess(repos: Repositories, actor: Actor, installationId: string): Promise<InstallationRecord> {
  const record = await repos.installations.get(installationId);
  if (!record) throw new AppError(404, 'not_found', 'Installation not found');
  if (actor.kind === 'installation') {
    if (actor.installationId !== installationId) throw new AppError(404, 'not_found', 'Installation not found');
    return record;
  }
  if (actor.role !== 'administrator') throw new AppError(403, 'forbidden', 'Insufficient role');
  return record;
}
