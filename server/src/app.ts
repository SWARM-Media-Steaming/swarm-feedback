import { existsSync } from 'node:fs';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor, InstallationActor, UserActor } from './actors.js';
import type { AppConfig } from './config.js';
import {
  ackSchema,
  deliveryStatuses,
  evaluatorTypes,
  parseBody,
  reviewStatuses,
  type FeedbackDeliveryStatus,
} from './domain.js';
import { AppError } from './errors.js';
import { toPublicUser } from './present.js';
import type { ExecutionQuery, FeedbackQuery } from './records.js';
import type { Repositories } from './repos/types.js';
import { apiKeyPrefix, sha256Hex, timingSafeEqualText, verifyJwt } from './security.js';
import { createUser, login } from './services/auth.js';
import { listExecutions, getExecutionDetail, getExecutionStatus, listQueue, updateExecution, uploadBatch, uploadExecution } from './services/executions.js';
import { createInstallation, disableInstallation, listInstallations, rotateInstallationKey } from './services/installations.js';
import {
  acknowledgeFeedback,
  claimExecution,
  getFeedback,
  listFeedback,
  markNeedsInformation,
  releaseExecution,
  saveDraft,
  submitReview,
} from './services/reviews.js';

export async function buildApp(config: AppConfig, repos: Repositories): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: config.limits.bodyBytes,
    logger: config.nodeEnv === 'test'
      ? false
      : {
          level: config.logLevel,
          redact: ['req.headers.authorization', 'req.headers["x-bootstrap-token"]'],
        },
  });

  const serveWeb = config.serveWeb && existsSync(config.webDistPath);
  if (config.serveWeb && config.nodeEnv === 'production' && !serveWeb) {
    throw new Error(`Reviewer UI was not found at ${config.webDistPath}`);
  }

  await app.register(helmet, {
    contentSecurityPolicy: serveWeb
      ? {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
          },
        }
      : false,
  });
  await app.register(cors, {
    origin: config.webOrigin.split(',').map((origin) => origin.trim()).filter(Boolean),
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Bootstrap-Token', 'X-Request-Id'],
  });
  await app.register(rateLimit, {
    global: true,
    max: config.limits.globalRateMax,
    timeWindow: '1 minute',
    keyGenerator: (request) => rateKey(request),
    errorResponseBuilder: () => ({ error: { code: 'rate_limited', message: 'Too many requests' } }),
  });
  if (serveWeb) {
    await app.register(fastifyStatic, { root: config.webDistPath });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
    }
    const statusCode = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (statusCode === 413) return reply.status(413).send({ error: { code: 'payload_too_large', message: 'Request body is too large' } });
    if (statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests' } });
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: 'bad_request', message: 'Request could not be processed' } });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal error' } });
  });

  app.addHook('preHandler', async (request) => {
    if (isPublic(request)) return;
    await authenticate(request, config, repos);
  });

  app.get('/api/v1/health', async () => ({ ok: true, version: 'v1' }));
  app.get('/api/v1/ready', async (_request, reply) => {
    const ready = await repos.health.ready();
    if (!ready) return reply.status(503).send({ ok: false, dynamodb: 'unavailable' });
    return { ok: true, dynamodb: 'ready' };
  });

  app.post('/api/v1/auth/login', { config: { rateLimit: { max: config.limits.loginRateMax, timeWindow: '1 minute' } } }, async (request) => {
    return login(config, repos, request.body, request.ip);
  });
  app.get('/api/v1/auth/me', async (request) => {
    const actor = requireUser(request);
    const user = await repos.users.get(actor.userId);
    if (!user || user.disabled) throw new AppError(401, 'unauthorized', 'Invalid session');
    return { user: toPublicUser(user) };
  });

  app.post('/api/v1/installations/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    assertBootstrap(request, config);
    return createInstallation(repos, { kind: 'system', id: 'bootstrap' }, request.body, request.ip);
  });

  app.post('/api/v1/installations', async (request) => {
    return createInstallation(repos, requireUser(request, ['administrator']), request.body, request.ip);
  });
  app.get('/api/v1/installations', async (request) => {
    const actor = requireUser(request, ['administrator', 'reviewer']);
    return { items: await listInstallations(repos, actor.role === 'administrator') };
  });
  app.post('/api/v1/installations/:installationId/rotate-key', async (request) => {
    const actor = requireUserOrInstallation(request);
    if (actor.kind === 'user' && actor.role !== 'administrator') throw new AppError(403, 'forbidden', 'Insufficient role');
    return rotateInstallationKey(repos, actor, uuidParam(request, 'installationId'), request.ip);
  });
  app.post('/api/v1/installations/:installationId/disable', async (request) => {
    return disableInstallation(repos, requireUser(request, ['administrator']), uuidParam(request, 'installationId'), request.ip);
  });

  app.post('/api/v1/users', async (request) => {
    const actor = requireUser(request, ['administrator']);
    return { user: await createUser(repos, actor, request.body, request.ip) };
  });
  app.get('/api/v1/users', async (request) => {
    requireUser(request, ['administrator']);
    const users = await repos.users.list();
    return { items: users.map(toPublicUser) };
  });

  const uploadLimit = { config: { rateLimit: { max: config.limits.uploadRateMax, timeWindow: '1 minute' } } };
  app.post('/api/v1/executions', uploadLimit, async (request, reply) => {
    const actor = requireInstallation(request);
    const result = await uploadExecution(config, repos, actor.installationId, request.body, request.ip);
    return reply.status(result.duplicate ? 200 : 201).send(uploadResponse(result.execution, result.duplicate));
  });
  app.post('/api/v1/executions/batch', uploadLimit, async (request) => {
    const actor = requireInstallation(request);
    return uploadBatch(config, repos, actor.installationId, request.body, request.ip);
  });
  app.get('/api/v1/executions', async (request) => {
    const actor = requireUserOrInstallation(request);
    return listExecutions(repos, actor, executionQuery(request.query, actor.kind === 'installation'));
  });
  app.get('/api/v1/executions/:executionId/status', async (request) => {
    return getExecutionStatus(repos, requireUserOrInstallation(request), uuidParam(request, 'executionId'));
  });
  app.get('/api/v1/executions/:executionId', async (request) => {
    return getExecutionDetail(config, repos, requireUserOrInstallation(request), uuidParam(request, 'executionId'));
  });
  app.patch('/api/v1/executions/:executionId', uploadLimit, async (request) => {
    const actor = requireInstallation(request);
    return updateExecution(config, repos, actor.installationId, uuidParam(request, 'executionId'), request.body, request.ip);
  });

  app.get('/api/v1/review-queue', async (request) => {
    requireUser(request, ['administrator', 'reviewer']);
    return listQueue(repos, executionQuery(request.query, false));
  });
  app.post('/api/v1/review-queue/:executionId/claim', async (request) => {
    return claimExecution(repos, requireUser(request, ['administrator', 'reviewer']), uuidParam(request, 'executionId'), request.ip);
  });
  app.post('/api/v1/review-queue/:executionId/release', async (request) => {
    return releaseExecution(repos, requireUser(request, ['administrator', 'reviewer']), uuidParam(request, 'executionId'), request.ip);
  });
  app.put('/api/v1/executions/:executionId/review', async (request) => {
    return saveDraft(config, repos, requireUser(request, ['administrator', 'reviewer']), uuidParam(request, 'executionId'), request.body, request.ip);
  });
  app.post('/api/v1/executions/:executionId/review/submit', async (request) => {
    return submitReview(config, repos, requireUser(request, ['administrator', 'reviewer']), uuidParam(request, 'executionId'), request.body, request.ip);
  });
  app.post('/api/v1/executions/:executionId/review/needs-information', async (request) => {
    return markNeedsInformation(config, repos, requireUser(request, ['administrator', 'reviewer']), uuidParam(request, 'executionId'), request.body, request.ip);
  });

  app.get('/api/v1/feedback', async (request) => {
    const actor = requireUserOrInstallation(request);
    return listFeedback(config, repos, actor, feedbackQuery(request.query, actor));
  });
  app.get('/api/v1/feedback/:reviewId', async (request) => {
    return getFeedback(config, repos, requireUserOrInstallation(request), uuidParam(request, 'reviewId'));
  });
  app.post('/api/v1/feedback/:reviewId/acknowledgements', async (request) => {
    const actor = requireUserOrInstallation(request);
    const body = parseBody(ackSchema, request.body);
    return acknowledgeFeedback(repos, actor, uuidParam(request, 'reviewId'), body.reviewVersion, request.ip);
  });

  app.get('/api/v1/audit', async (request) => {
    requireUser(request, ['administrator']);
    const limit = limitOf(queryRecord(request.query).limit, 50);
    return { items: await repos.audit.listRecent(limit) };
  });

  app.setNotFoundHandler((request, reply) => {
    if (serveWeb && request.method === 'GET' && !request.url.split('?')[0].startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return app;
}

function uploadResponse(execution: { executionId: string; processingStatus: string; reviewStatus: string; revision: number; createdAt: string }, duplicate: boolean) {
  return {
    executionId: execution.executionId,
    duplicate,
    uploadStatus: 'accepted',
    processingStatus: execution.processingStatus,
    reviewStatus: execution.reviewStatus,
    revision: execution.revision,
    receivedAt: execution.createdAt,
  };
}

function isPublic(request: FastifyRequest): boolean {
  const pathname = request.url.split('?')[0];
  if (!pathname.startsWith('/api/')) return true;
  if (request.method === 'GET' && (pathname === '/api/v1/health' || pathname === '/api/v1/ready')) return true;
  if (request.method === 'POST' && (pathname === '/api/v1/auth/login' || pathname === '/api/v1/installations/register')) return true;
  return false;
}

async function authenticate(request: FastifyRequest, config: AppConfig, repos: Repositories): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'unauthorized', 'Authentication required');
  const token = header.slice('Bearer '.length).trim();
  if (token.startsWith('sf_')) {
    const matches = await repos.installations.findByPrefix(apiKeyPrefix(token));
    const hash = sha256Hex(token);
    const installation = matches.find((item) => item.status === 'active' && timingSafeEqualText(item.apiKeyHash, hash));
    if (!installation) throw new AppError(401, 'unauthorized', 'Invalid API key');
    request.actor = { kind: 'installation', installationId: installation.installationId };
    return;
  }
  const claims = verifyJwt(token, config.jwtSecret);
  const user = await repos.users.get(claims.sub);
  if (!user || user.disabled) throw new AppError(401, 'unauthorized', 'Invalid session');
  request.actor = { kind: 'user', userId: user.userId, role: user.role, email: user.email, name: user.name };
}

function assertBootstrap(request: FastifyRequest, config: AppConfig): void {
  const provided = request.headers['x-bootstrap-token'];
  if (!config.bootstrapToken || typeof provided !== 'string' || !timingSafeEqualText(provided, config.bootstrapToken)) {
    throw new AppError(401, 'unauthorized', 'Invalid bootstrap token');
  }
}

function requireUser(request: FastifyRequest, roles?: Array<UserActor['role']>): UserActor {
  if (request.actor?.kind !== 'user') throw new AppError(401, 'unauthorized', 'User authentication required');
  if (roles && !roles.includes(request.actor.role)) throw new AppError(403, 'forbidden', 'Insufficient role');
  return request.actor;
}

function requireInstallation(request: FastifyRequest): InstallationActor {
  if (request.actor?.kind !== 'installation') throw new AppError(401, 'unauthorized', 'Installation authentication required');
  return request.actor;
}

function requireUserOrInstallation(request: FastifyRequest): Actor {
  if (!request.actor) throw new AppError(401, 'unauthorized', 'Authentication required');
  return request.actor;
}

function uuidParam(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new AppError(400, 'validation_error', `Invalid ${name}`);
  return parsed.data;
}

function executionQuery(query: unknown, customerList: boolean): ExecutionQuery {
  const record = queryRecord(query);
  const statusRaw = record.status === 'all' ? undefined : record.status;
  return {
    reviewStatus: enumParam(statusRaw, reviewStatuses, 'status'),
    installationId: optionalUuid(record.installationId, 'installationId'),
    repositoryKey: optionalText(record.repository, 300)?.toLowerCase(),
    q: optionalText(record.q, 200)?.toLowerCase(),
    limit: limitOf(record.limit, customerList ? 25 : 25),
    cursor: optionalText(record.cursor, 4000),
  };
}

function feedbackQuery(query: unknown, actor: Actor): FeedbackQuery {
  const record = queryRecord(query);
  const installationId = actor.kind === 'installation'
    ? actor.installationId
    : optionalUuid(record.installationId, 'installationId');
  if (!installationId) throw new AppError(400, 'validation_error', 'installationId is required');
  return {
    installationId,
    executionId: optionalUuid(record.executionId, 'executionId'),
    deliveryStatus: enumParam(record.deliveryStatus, deliveryStatuses, 'deliveryStatus') as FeedbackDeliveryStatus | undefined,
    evaluatorType: enumParam(record.evaluatorType, evaluatorTypes, 'evaluatorType'),
    limit: limitOf(record.limit, 25),
    cursor: optionalText(record.cursor, 4000),
  };
}

function queryRecord(query: unknown): Record<string, unknown> {
  return query && typeof query === 'object' ? query as Record<string, unknown> : {};
}

function enumParam<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new AppError(400, 'validation_error', `${name} is invalid`);
  }
  return value as T;
}

function optionalUuid(value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new AppError(400, 'validation_error', `Invalid ${name}`);
  return parsed.data;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new AppError(400, 'validation_error', 'Invalid query parameter');
  const trimmed = value.trim();
  return trimmed || undefined;
}

function limitOf(value: unknown, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new AppError(400, 'validation_error', 'limit must be an integer from 1 to 100');
  }
  return parsed;
}

function rateKey(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer sf_')) return `key:${header.slice(7, 23)}`;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return `bearer:${header.slice(-24)}`;
  return request.ip;
}
