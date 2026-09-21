import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from '../config.js';
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

type TableSpec = {
  suffix: string;
  hash: string;
  attributes: string[];
  indexes: { name: string; hash: string; range: string }[];
};

const TABLES: TableSpec[] = [
  { suffix: 'installations', hash: 'installationId', attributes: ['installationId', 'apiKeyPrefix'], indexes: [{ name: 'byPrefix', hash: 'apiKeyPrefix', range: 'installationId' }] },
  { suffix: 'users', hash: 'userId', attributes: ['userId', 'email'], indexes: [{ name: 'byEmail', hash: 'email', range: 'userId' }] },
  { suffix: 'executions', hash: 'executionId', attributes: ['executionId', 'installationId', 'createdAt', 'reviewStatus', 'repositoryKey'], indexes: [
    { name: 'byInstallation', hash: 'installationId', range: 'createdAt' },
    { name: 'byStatus', hash: 'reviewStatus', range: 'createdAt' },
    { name: 'byRepository', hash: 'repositoryKey', range: 'createdAt' },
  ] },
  { suffix: 'reviews', hash: 'reviewId', attributes: ['reviewId', 'executionId', 'createdAt', 'installationId', 'submittedAt'], indexes: [
    { name: 'byExecution', hash: 'executionId', range: 'createdAt' },
    { name: 'byInstallation', hash: 'installationId', range: 'submittedAt' },
  ] },
  { suffix: 'audit', hash: 'auditId', attributes: ['auditId', 'day', 'createdAt'], indexes: [{ name: 'byDay', hash: 'day', range: 'createdAt' }] },
  { suffix: 'migrations', hash: 'migrationId', attributes: ['migrationId'], indexes: [] },
];

export type DynamoHandle = {
  repos: Repositories;
  migrate: () => Promise<void>;
  dropAll: () => Promise<void>;
};

export function connectDynamo(config: AppConfig): DynamoHandle {
  const raw = new DynamoDBClient({
    region: config.dynamodb.region,
    endpoint: config.dynamodb.endpoint,
    credentials: config.dynamodb.endpoint
      ? {
          accessKeyId: config.dynamodb.accessKeyId ?? 'local',
          secretAccessKey: config.dynamodb.secretAccessKey ?? 'local',
        }
      : undefined,
  });
  const doc = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const name = (suffix: string) => `${config.dynamodb.tablePrefix}${suffix}`;

  const repos: Repositories = {
    installations: {
      async create(record) {
        await putNew(doc, name('installations'), record, 'installationId');
      },
      async get(id) {
        return getItem<InstallationRecord>(doc, name('installations'), { installationId: id });
      },
      async list() {
        const items = await scanAll<InstallationRecord>(doc, name('installations'));
        return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },
      async findByPrefix(prefix) {
        const result = await doc.send(new QueryCommand({
          TableName: name('installations'),
          IndexName: 'byPrefix',
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'apiKeyPrefix' },
          ExpressionAttributeValues: { ':pk': prefix },
        }));
        return (result.Items ?? []) as InstallationRecord[];
      },
      async update(record) {
        await doc.send(new PutCommand({ TableName: name('installations'), Item: record }));
      },
    },
    users: {
      async create(record) {
        await putNew(doc, name('users'), record, 'userId');
      },
      async get(id) {
        return getItem<UserRecord>(doc, name('users'), { userId: id });
      },
      async findByEmail(email) {
        const result = await doc.send(new QueryCommand({
          TableName: name('users'),
          IndexName: 'byEmail',
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'email' },
          ExpressionAttributeValues: { ':pk': email.toLowerCase() },
          Limit: 1,
        }));
        return (result.Items?.[0] as UserRecord | undefined) ?? null;
      },
      async list() {
        const items = await scanAll<UserRecord>(doc, name('users'));
        return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },
    },
    executions: {
      async create(record) {
        try {
          await doc.send(new PutCommand({
            TableName: name('executions'),
            Item: record,
            ConditionExpression: 'attribute_not_exists(executionId)',
          }));
          return 'created';
        } catch (error) {
          if (isConditional(error)) return 'exists';
          throw error;
        }
      },
      async get(id) {
        return getItem<ExecutionRecord>(doc, name('executions'), { executionId: id });
      },
      async compareAndSwap(expectedRevision, next) {
        try {
          await doc.send(new PutCommand({
            TableName: name('executions'),
            Item: next,
            ConditionExpression: 'revision = :expected',
            ExpressionAttributeValues: { ':expected': expectedRevision },
          }));
          return true;
        } catch (error) {
          if (isConditional(error)) return false;
          throw error;
        }
      },
      async query(params) {
        return queryExecutions(doc, name('executions'), params);
      },
    },
    reviews: {
      async create(record) {
        await putNew(doc, name('reviews'), record, 'reviewId');
      },
      async get(id) {
        return getItem<ReviewRecord>(doc, name('reviews'), { reviewId: id });
      },
      async save(record) {
        await doc.send(new PutCommand({ TableName: name('reviews'), Item: record }));
      },
      async listByExecution(executionId) {
        const result = await doc.send(new QueryCommand({
          TableName: name('reviews'),
          IndexName: 'byExecution',
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'executionId' },
          ExpressionAttributeValues: { ':pk': executionId },
          ScanIndexForward: true,
        }));
        return (result.Items ?? []) as ReviewRecord[];
      },
      async queryByInstallation(params) {
        return queryFeedback(doc, name('reviews'), params);
      },
    },
    audit: {
      async put(record) {
        await doc.send(new PutCommand({ TableName: name('audit'), Item: record }));
      },
      async listRecent(limit) {
        const days = recentDays(7);
        const batches = await Promise.all(days.map(async (day) => {
          const result = await doc.send(new QueryCommand({
            TableName: name('audit'),
            IndexName: 'byDay',
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'day' },
            ExpressionAttributeValues: { ':pk': day },
            ScanIndexForward: false,
            Limit: limit,
          }));
          return (result.Items ?? []) as AuditRecord[];
        }));
        return batches.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      },
    },
    health: {
      async ready() {
        try {
          const described = await raw.send(new DescribeTableCommand({ TableName: name('installations') }));
          return described.Table?.TableStatus === 'ACTIVE';
        } catch {
          return false;
        }
      },
    },
  };

  return {
    repos,
    async migrate() {
      for (const spec of TABLES) await ensureTable(raw, name(spec.suffix), spec);
      await doc.send(new UpdateCommand({
        TableName: name('migrations'),
        Key: { migrationId: '001_init' },
        UpdateExpression: 'SET appliedAt = if_not_exists(appliedAt, :now)',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      }));
    },
    async dropAll() {
      for (const spec of TABLES) {
        try {
          await raw.send(new DeleteTableCommand({ TableName: name(spec.suffix) }));
        } catch (error) {
          if (!(error instanceof ResourceNotFoundException) && (error as { name?: string }).name !== 'ResourceNotFoundException') {
            throw error;
          }
        }
      }
    },
  };
}

async function putNew(doc: DynamoDBDocumentClient, table: string, item: object, key: string): Promise<void> {
  await doc.send(new PutCommand({
    TableName: table,
    Item: item,
    ConditionExpression: `attribute_not_exists(#key)`,
    ExpressionAttributeNames: { '#key': key },
  }));
}

async function getItem<T>(doc: DynamoDBDocumentClient, table: string, key: Record<string, string>): Promise<T | null> {
  const result = await doc.send(new GetCommand({ TableName: table, Key: key }));
  return (result.Item as T | undefined) ?? null;
}

async function scanAll<T>(doc: DynamoDBDocumentClient, table: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: cursor }));
    items.push(...((result.Items ?? []) as T[]));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return items;
}

async function queryExecutions(doc: DynamoDBDocumentClient, table: string, params: ExecutionQuery): Promise<Page<ExecutionRecord>> {
  const choice = chooseExecutionIndex(params);
  const filters: string[] = [];
  const names: Record<string, string> = { ...(choice.names ?? {}) };
  const values: Record<string, unknown> = { ...(choice.values ?? {}) };
  if (params.reviewStatus && choice.partition !== 'reviewStatus') addEq(filters, names, values, 'reviewStatus', params.reviewStatus);
  if (params.installationId && choice.partition !== 'installationId') addEq(filters, names, values, 'installationId', params.installationId);
  if (params.repositoryKey && choice.partition !== 'repositoryKey') addEq(filters, names, values, 'repositoryKey', params.repositoryKey);
  if (params.q) {
    filters.push('contains(#searchText, :q)');
    names['#searchText'] = 'searchText';
    values[':q'] = params.q;
  }
  if (!choice.indexName) {
    return scanPage<ExecutionRecord>(doc, table, params.limit, params.cursor, filters, names, values);
  }
  return indexedPage<ExecutionRecord>(doc, table, choice.indexName, choice.keyExpression!, params.limit, params.cursor, filters, names, values, false);
}

function chooseExecutionIndex(params: ExecutionQuery): {
  indexName?: string;
  partition?: string;
  keyExpression?: string;
  names?: Record<string, string>;
  values?: Record<string, unknown>;
} {
  if (params.installationId) {
    return {
      indexName: 'byInstallation',
      partition: 'installationId',
      keyExpression: '#pk = :pk',
      names: { '#pk': 'installationId' },
      values: { ':pk': params.installationId },
    };
  }
  if (params.reviewStatus) {
    return {
      indexName: 'byStatus',
      partition: 'reviewStatus',
      keyExpression: '#pk = :pk',
      names: { '#pk': 'reviewStatus' },
      values: { ':pk': params.reviewStatus },
    };
  }
  if (params.repositoryKey) {
    return {
      indexName: 'byRepository',
      partition: 'repositoryKey',
      keyExpression: '#pk = :pk',
      names: { '#pk': 'repositoryKey' },
      values: { ':pk': params.repositoryKey },
    };
  }
  return {};
}

async function queryFeedback(doc: DynamoDBDocumentClient, table: string, params: FeedbackQuery): Promise<Page<ReviewRecord>> {
  const filters: string[] = [];
  const names: Record<string, string> = { '#pk': 'installationId' };
  const values: Record<string, unknown> = { ':pk': params.installationId };
  if (params.executionId) addEq(filters, names, values, 'executionId', params.executionId);
  if (params.deliveryStatus) addEq(filters, names, values, 'feedbackDeliveryStatus', params.deliveryStatus);
  if (params.evaluatorType) addEq(filters, names, values, 'evaluatorType', params.evaluatorType);
  return indexedPage<ReviewRecord>(doc, table, 'byInstallation', '#pk = :pk', params.limit, params.cursor, filters, names, values, false);
}

function addEq(filters: string[], names: Record<string, string>, values: Record<string, unknown>, attribute: string, value: string): void {
  const placeholder = `#f_${attribute}`;
  const valueKey = `:f_${attribute}`;
  filters.push(`${placeholder} = ${valueKey}`);
  names[placeholder] = attribute;
  values[valueKey] = value;
}

async function indexedPage<T>(
  doc: DynamoDBDocumentClient,
  table: string,
  indexName: string,
  keyExpression: string,
  limit: number,
  cursor: string | null | undefined,
  filters: string[],
  names: Record<string, string>,
  values: Record<string, unknown>,
  forward: boolean,
): Promise<Page<T>> {
  const result = await doc.send(new QueryCommand({
    TableName: table,
    IndexName: indexName,
    KeyConditionExpression: keyExpression,
    FilterExpression: filters.length ? filters.join(' AND ') : undefined,
    ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    ExpressionAttributeValues: values,
    Limit: limit,
    ScanIndexForward: forward,
    ExclusiveStartKey: decodeCursor(cursor),
  }));
  return { items: (result.Items ?? []) as T[], nextCursor: encodeCursor(result.LastEvaluatedKey) };
}

async function scanPage<T>(
  doc: DynamoDBDocumentClient,
  table: string,
  limit: number,
  cursor: string | null | undefined,
  filters: string[],
  names: Record<string, string>,
  values: Record<string, unknown>,
): Promise<Page<T>> {
  const result = await doc.send(new ScanCommand({
    TableName: table,
    FilterExpression: filters.length ? filters.join(' AND ') : undefined,
    ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
    Limit: limit,
    ExclusiveStartKey: decodeCursor(cursor),
  }));
  return { items: (result.Items ?? []) as T[], nextCursor: encodeCursor(result.LastEvaluatedKey) };
}

function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  if (!key || Object.keys(key).length === 0) return null;
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(cursor?: string | null): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
    return parsed;
  } catch {
    throw new AppError(400, 'validation_error', 'Invalid cursor');
  }
}

function recentDays(count: number): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let offset = 0; offset < count; offset += 1) {
    const day = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

async function ensureTable(raw: DynamoDBClient, tableName: string, spec: TableSpec): Promise<void> {
  try {
    const described = await raw.send(new DescribeTableCommand({ TableName: tableName }));
    const present = new Set((described.Table?.GlobalSecondaryIndexes ?? []).map((index) => index.IndexName));
    for (const index of spec.indexes) {
      if (!present.has(index.name)) {
        throw new Error(`Table ${tableName} is missing index ${index.name}. Use a new DYNAMODB_TABLE_PREFIX or recreate the table.`);
      }
    }
    await waitUntilActive(raw, tableName);
    return;
  } catch (error) {
    if ((error as { name?: string }).name !== 'ResourceNotFoundException' && !(error instanceof ResourceNotFoundException)) {
      throw error;
    }
  }

  const attributes: AttributeDefinition[] = spec.attributes.map((attribute) => ({ AttributeName: attribute, AttributeType: 'S' }));
  const indexes: GlobalSecondaryIndex[] = spec.indexes.map((index) => ({
    IndexName: index.name,
    KeySchema: [
      { AttributeName: index.hash, KeyType: 'HASH' },
      { AttributeName: index.range, KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  }));
  try {
    await raw.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: attributes,
      KeySchema: [{ AttributeName: spec.hash, KeyType: 'HASH' }],
      GlobalSecondaryIndexes: indexes.length ? indexes : undefined,
    }));
  } catch (error) {
    if ((error as { name?: string }).name !== 'ResourceInUseException' && !(error instanceof ResourceInUseException)) throw error;
  }
  await waitUntilActive(raw, tableName);
}

async function waitUntilActive(raw: DynamoDBClient, tableName: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const described = await raw.send(new DescribeTableCommand({ TableName: tableName }));
    const indexesReady = (described.Table?.GlobalSecondaryIndexes ?? []).every((index) => index.IndexStatus === 'ACTIVE');
    if (described.Table?.TableStatus === 'ACTIVE' && indexesReady) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`DynamoDB table ${tableName} did not become active`);
}

function isConditional(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && (error as { name: string }).name === 'ConditionalCheckFailedException';
}
