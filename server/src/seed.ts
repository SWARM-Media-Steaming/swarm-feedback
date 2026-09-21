import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { UserRole } from './domain.js';
import type { Repositories } from './repos/types.js';
import { hashPassword } from './security.js';

export async function seedDemo(config: AppConfig, repos: Repositories): Promise<void> {
  if (!config.seed.enabled) return;
  await ensureUser(repos, config.seed.adminEmail, config.seed.adminName, config.seed.adminPassword, 'administrator');
  await ensureUser(repos, config.seed.reviewerEmail, config.seed.reviewerName, config.seed.reviewerPassword, 'reviewer');
}

async function ensureUser(repos: Repositories, email: string, name: string, password: string, role: UserRole): Promise<void> {
  const existing = await repos.users.findByEmail(email);
  if (existing) return;
  await repos.users.create({
    userId: randomUUID(),
    email,
    name,
    role,
    passwordHash: await hashPassword(password),
    disabled: false,
    createdAt: new Date().toISOString(),
  });
}
