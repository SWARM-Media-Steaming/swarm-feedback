import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { AppError } from './errors.js';

function scrypt(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export type SecretFinding = { type: string; path: string };

type Pattern = {
  type: string;
  source: string;
  flags: string;
  replace?: (match: string, ...groups: string[]) => string;
};

const PATTERNS: Pattern[] = [
  {
    type: 'private_key',
    source: '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
    flags: 'g',
  },
  {
    type: 'github_token',
    source: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\\b|\\bgithub_pat_[A-Za-z0-9_]{20,}\\b',
    flags: 'g',
  },
  { type: 'aws_access_key', source: '\\bAKIA[0-9A-Z]{16}\\b', flags: 'g' },
  {
    type: 'aws_secret_access_key',
    source: '\\b(aws_secret_access_key)\\s*[:=]\\s*([\'"]?)([A-Za-z0-9/+=]{40})\\2',
    flags: 'gi',
    replace: (_match, key: string) => `${key}=[REDACTED:aws_secret_access_key]`,
  },
  { type: 'slack_token', source: '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b', flags: 'g' },
  { type: 'openai_key', source: '\\bsk-(?:proj-|ant-)?[A-Za-z0-9_\\-]{20,}\\b', flags: 'g' },
  { type: 'google_api_key', source: '\\bAIza[0-9A-Za-z_\\-]{35}\\b', flags: 'g' },
  { type: 'stripe_key', source: '\\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\\b', flags: 'g' },
  { type: 'npm_token', source: '\\bnpm_[A-Za-z0-9]{36}\\b', flags: 'g' },
  {
    type: 'bearer_jwt',
    source: '\\bBearer\\s+[A-Za-z0-9\\-_]{20,}\\.[A-Za-z0-9\\-_]{10,}\\.[A-Za-z0-9\\-_]{10,}\\b',
    flags: 'g',
  },
  {
    type: 'assigned_secret',
    source: '\\b(api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token|github[_-]?token)\\s*[:=]\\s*([\'"]?)([^\\s\'"]{20,})\\2',
    flags: 'gi',
    replace: (match, key: string, _quote: string, value: string) => {
      if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return match;
      return `${key}=[REDACTED:assigned_secret]`;
    },
  },
];

export function redactSecrets(value: unknown, path = '$'): { value: unknown; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  return { value: walk(value, path, findings), findings };
}

function walk(value: unknown, path: string, findings: SecretFinding[]): unknown {
  if (typeof value === 'string') return redactString(value, path, findings);
  if (Array.isArray(value)) return value.map((entry, index) => walk(entry, `${path}[${index}]`, findings));
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = walk(child, `${path}.${key}`, findings);
  }
  return next;
}

function redactString(input: string, path: string, findings: SecretFinding[]): string {
  let output = input;
  for (const pattern of PATTERNS) {
    const detected = new RegExp(pattern.source, pattern.flags);
    if (!detected.test(output)) continue;
    findings.push({ type: pattern.type, path });
    const replacer = new RegExp(pattern.source, pattern.flags);
    output = pattern.replace
      ? output.replace(replacer, pattern.replace as (match: string, ...groups: string[]) => string)
      : output.replace(replacer, `[REDACTED:${pattern.type}]`);
  }
  return output;
}

export function canonicalStringify(value: unknown): string {
  if (value === undefined || value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalStringify(entry)}`).join(',')}}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function generateApiKey(): string {
  return `sf_${randomBytes(32).toString('base64url')}`;
}

export function apiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, 16);
}

export function encryptString(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptString(key: Buffer, payload: string): string {
  if (!payload.startsWith('enc:v1:')) return payload;
  const parts = payload.split(':');
  if (parts.length !== 5) throw new AppError(500, 'decryption_failed', 'Stored field could not be decrypted');
  try {
    const iv = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    const data = Buffer.from(parts[4], 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError(500, 'decryption_failed', 'Stored field could not be decrypted');
  }
}

export function encryptOptional(key: Buffer, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return encryptString(key, value);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, salt, hash] = encoded.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = await scrypt(password, salt);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export type JwtClaims = {
  sub: string;
  role: 'administrator' | 'reviewer';
  email: string;
  name: string;
};

export function signJwt(claims: JwtClaims, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }));
  const signature = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string, secret: string): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AppError(401, 'unauthorized', 'Invalid session');
  const [headerPart, bodyPart, signature] = parts;
  const expected = sign(`${headerPart}.${bodyPart}`, secret);
  if (!timingSafeEqualText(signature, expected)) throw new AppError(401, 'unauthorized', 'Invalid session');
  let header: { alg?: string };
  let payload: JwtClaims & { exp?: number };
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { alg?: string };
    payload = JSON.parse(Buffer.from(bodyPart, 'base64url').toString('utf8')) as JwtClaims & { exp?: number };
  } catch {
    throw new AppError(401, 'unauthorized', 'Invalid session');
  }
  if (header.alg !== 'HS256') throw new AppError(401, 'unauthorized', 'Invalid session');
  if (!payload.sub || !payload.role || !payload.email || !payload.exp) {
    throw new AppError(401, 'unauthorized', 'Invalid session');
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new AppError(401, 'unauthorized', 'Session expired');
  return { sub: payload.sub, role: payload.role, email: payload.email, name: payload.name };
}

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}
