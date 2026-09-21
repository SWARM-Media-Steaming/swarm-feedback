import path from 'node:path';
import { repoRoot } from './env.js';

export const DEV_JWT_SECRET = 'local-dev-jwt-secret-change-before-prod';
export const DEV_ENCRYPTION_KEY = '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210';
export const DEV_BOOTSTRAP_TOKEN = 'local-bootstrap-token';
export const DEV_ADMIN_PASSWORD = 'local-admin-pass-1';
export const DEV_REVIEWER_PASSWORD = 'local-reviewer-pass-1';

export type AppConfig = {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: string;
  webOrigin: string;
  serveWeb: boolean;
  webDistPath: string;
  trustProxy: boolean;
  jwtSecret: string;
  jwtTtlSeconds: number;
  dataEncryptionKey: Buffer;
  bootstrapToken: string | null;
  dynamodb: {
    region: string;
    endpoint?: string;
    tablePrefix: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  seed: {
    enabled: boolean;
    adminEmail: string;
    adminPassword: string;
    adminName: string;
    reviewerEmail: string;
    reviewerPassword: string;
    reviewerName: string;
  };
  limits: {
    bodyBytes: number;
    globalRateMax: number;
    uploadRateMax: number;
    loginRateMax: number;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  const production = nodeEnv === 'production';
  const development = nodeEnv === 'development';

  const jwtSecret = requiredSecret(env, 'JWT_SECRET', development ? DEV_JWT_SECRET : undefined);
  const keyHex = requiredSecret(env, 'DATA_ENCRYPTION_KEY_HEX', development ? DEV_ENCRYPTION_KEY : undefined);
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  const dataEncryptionKey = parseKey(keyHex);

  const seedEnabled = boolEnv(env, 'SEED_DEMO', development);
  if (production) {
    if (jwtSecret === DEV_JWT_SECRET) throw new Error('Refusing to start in production with the development JWT_SECRET');
    if (keyHex.toLowerCase() === DEV_ENCRYPTION_KEY) {
      throw new Error('Refusing to start in production with the development encryption key');
    }
    if (seedEnabled) throw new Error('SEED_DEMO must be disabled in production');
    if (env.BOOTSTRAP_TOKEN === DEV_BOOTSTRAP_TOKEN) {
      throw new Error('Refusing to start in production with the development bootstrap token');
    }
    const endpoint = env.DYNAMODB_ENDPOINT?.trim();
    if (endpoint && /localhost|127\.0\.0\.1/.test(endpoint)) {
      throw new Error('Refusing to start in production with a local DynamoDB endpoint');
    }
  }

  const adminPassword = env.ADMIN_PASSWORD?.trim() || (seedEnabled && development ? DEV_ADMIN_PASSWORD : '');
  const reviewerPassword = env.REVIEWER_PASSWORD?.trim() || (seedEnabled && development ? DEV_REVIEWER_PASSWORD : '');
  if (seedEnabled) {
    if (!env.ADMIN_EMAIL?.trim() && !development) throw new Error('ADMIN_EMAIL is required when SEED_DEMO is enabled');
    if (!adminPassword || !reviewerPassword) throw new Error('Seed passwords are required when SEED_DEMO is enabled');
    if (production) throw new Error('SEED_DEMO must be disabled in production');
  }

  const endpoint = env.DYNAMODB_ENDPOINT?.trim();
  return {
    nodeEnv,
    host: env.HOST?.trim() || '0.0.0.0',
    port: intEnv(env, 'PORT', 8787, 1, 65535),
    logLevel: env.LOG_LEVEL?.trim() || (production ? 'info' : 'debug'),
    webOrigin: env.WEB_ORIGIN?.trim() || 'http://localhost:5173',
    serveWeb: boolEnv(env, 'SERVE_WEB', production),
    webDistPath: path.resolve(env.WEB_DIST?.trim() || path.join(repoRoot(), 'web', 'dist')),
    trustProxy: boolEnv(env, 'TRUST_PROXY', false),
    jwtSecret,
    jwtTtlSeconds: intEnv(env, 'JWT_TTL_SECONDS', 12 * 60 * 60, 300, 60 * 60 * 24 * 14),
    dataEncryptionKey,
    bootstrapToken: env.BOOTSTRAP_TOKEN?.trim() || (development ? DEV_BOOTSTRAP_TOKEN : null),
    dynamodb: {
      region: env.DYNAMODB_REGION?.trim() || 'us-east-1',
      endpoint: endpoint || undefined,
      tablePrefix: env.DYNAMODB_TABLE_PREFIX?.trim() || 'swarmfb_',
      accessKeyId: env.AWS_ACCESS_KEY_ID?.trim() || (endpoint ? 'local' : undefined),
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY?.trim() || (endpoint ? 'local' : undefined),
    },
    seed: {
      enabled: seedEnabled,
      adminEmail: (env.ADMIN_EMAIL?.trim() || 'admin@localhost').toLowerCase(),
      adminPassword,
      adminName: env.ADMIN_NAME?.trim() || 'Local Admin',
      reviewerEmail: (env.REVIEWER_EMAIL?.trim() || 'reviewer@localhost').toLowerCase(),
      reviewerPassword,
      reviewerName: env.REVIEWER_NAME?.trim() || 'Local Reviewer',
    },
    limits: {
      bodyBytes: intEnv(env, 'BODY_LIMIT_BYTES', 1_500_000, 10_000, 5_000_000),
      globalRateMax: intEnv(env, 'GLOBAL_RATE_MAX', 300, 1, 100_000),
      uploadRateMax: intEnv(env, 'UPLOAD_RATE_MAX', 60, 1, 100_000),
      loginRateMax: intEnv(env, 'LOGIN_RATE_MAX', 20, 1, 100_000),
    },
  };
}

function requiredSecret(env: NodeJS.ProcessEnv, key: string, fallback: string | undefined): string {
  const value = env[key]?.trim() || fallback;
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('DATA_ENCRYPTION_KEY_HEX must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${key} must be true or false`);
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}
