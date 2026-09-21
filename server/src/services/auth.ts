import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { createUserSchema, loginSchema, parseBody } from '../domain.js';
import { AppError } from '../errors.js';
import type { UserRecord } from '../records.js';
import type { Repositories } from '../repos/types.js';
import { hashPassword, signJwt, verifyPassword } from '../security.js';
import { writeAudit } from '../audit.js';
import { toPublicUser } from '../present.js';

let dummyHashPromise: Promise<string> | undefined;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('dummy-password-not-used');
  return dummyHashPromise;
}

export async function login(config: AppConfig, repos: Repositories, body: unknown, ip: string | undefined) {
  const input = parseBody(loginSchema, body);
  const email = input.email.toLowerCase();
  const user = await repos.users.findByEmail(email);
  const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash()));
  if (!user || user.disabled || !ok) {
    await writeAudit(repos, { kind: 'system', id: 'login' }, 'auth.login_failed', 'user', email, ip);
    throw new AppError(401, 'unauthorized', 'Invalid email or password');
  }
  const token = signJwt(
    { sub: user.userId, role: user.role, email: user.email, name: user.name },
    config.jwtSecret,
    config.jwtTtlSeconds,
  );
  await writeAudit(repos, { kind: 'user', userId: user.userId, role: user.role, email: user.email, name: user.name }, 'auth.login', 'user', user.userId, ip);
  return { token, user: toPublicUser(user) };
}

export async function createUser(
  repos: Repositories,
  actor: { userId: string; role: 'administrator' | 'reviewer'; email: string; name: string },
  body: unknown,
  ip: string | undefined,
) {
  const input = parseBody(createUserSchema, body);
  const email = input.email.toLowerCase();
  if (await repos.users.findByEmail(email)) {
    throw new AppError(409, 'email_in_use', 'A user with that email already exists');
  }
  const record: UserRecord = {
    userId: randomUUID(),
    email,
    name: input.name,
    role: input.role,
    passwordHash: await hashPassword(input.password),
    disabled: false,
    createdAt: new Date().toISOString(),
  };
  await repos.users.create(record);
  await writeAudit(repos, { kind: 'user', ...actor }, 'user.created', 'user', record.userId, ip, { role: record.role });
  return toPublicUser(record);
}
