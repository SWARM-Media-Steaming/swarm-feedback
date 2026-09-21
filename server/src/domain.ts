import { z } from 'zod';
import { AppError } from './errors.js';

export const SCORE_KEYS = [
  'promptClarity',
  'promptCompleteness',
  'contextQuality',
  'technicalSpecificity',
  'constraintQuality',
  'intentUnderstanding',
  'implementationQuality',
  'efficiency',
  'overallPromptQuality',
] as const;

export type ScoreKey = (typeof SCORE_KEYS)[number];
export type Scores = Record<ScoreKey, number>;
export type PartialScores = Partial<Scores>;

export const reviewStatuses = ['pending', 'in_review', 'completed', 'needs_more_information'] as const;
export type ReviewStatus = (typeof reviewStatuses)[number];

export const processingStatuses = ['received', 'processing', 'ready_for_review', 'rejected'] as const;
export type ProcessingStatus = (typeof processingStatuses)[number];

export const outcomeStatuses = ['success', 'partial', 'failed', 'cancelled'] as const;
export type OutcomeStatus = (typeof outcomeStatuses)[number];

export const deliveryStatuses = ['not_ready', 'available', 'acknowledged'] as const;
export type FeedbackDeliveryStatus = (typeof deliveryStatuses)[number];

export const evaluatorTypes = ['human', 'automated'] as const;
export type EvaluatorType = (typeof evaluatorTypes)[number];

export const userRoles = ['administrator', 'reviewer'] as const;
export type UserRole = (typeof userRoles)[number];

const scoreValue = z.number().int().min(1).max(5);

export const scoresSchema = z
  .object({
    promptClarity: scoreValue,
    promptCompleteness: scoreValue,
    contextQuality: scoreValue,
    technicalSpecificity: scoreValue,
    constraintQuality: scoreValue,
    intentUnderstanding: scoreValue,
    implementationQuality: scoreValue,
    efficiency: scoreValue,
    overallPromptQuality: scoreValue,
  })
  .strict();

export const partialScoresSchema = z
  .object({
    promptClarity: scoreValue.optional(),
    promptCompleteness: scoreValue.optional(),
    contextQuality: scoreValue.optional(),
    technicalSpecificity: scoreValue.optional(),
    constraintQuality: scoreValue.optional(),
    intentUnderstanding: scoreValue.optional(),
    implementationQuality: scoreValue.optional(),
    efficiency: scoreValue.optional(),
    overallPromptQuality: scoreValue.optional(),
  })
  .strict();

const fileChangeSchema = z
  .object({
    path: z.string().min(1).max(1024),
    changeType: z.enum(['added', 'modified', 'deleted', 'renamed']),
    additions: z.number().int().nonnegative().max(1_000_000).optional(),
    deletions: z.number().int().nonnegative().max(1_000_000).optional(),
    previousPath: z.string().min(1).max(1024).optional(),
  })
  .strict();

const pullRequestSchema = z
  .object({
    number: z.number().int().positive().optional(),
    url: z.string().url().max(2000).optional(),
    title: z.string().max(500).optional(),
    state: z.string().max(50).optional(),
  })
  .strict();

const commitSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-fA-F]{7,64}$/),
    message: z.string().max(5000),
    url: z.string().url().max(2000).optional(),
  })
  .strict();

const errorSchema = z
  .object({
    code: z.string().max(100).optional(),
    message: z.string().min(1).max(5000),
    severity: z.enum(['error', 'warning']).optional(),
  })
  .strict();

const warningSchema = z
  .object({
    code: z.string().max(100).optional(),
    message: z.string().min(1).max(5000),
  })
  .strict();

export const executionUploadSchema = z
  .object({
    executionId: z.string().uuid(),
    schemaVersion: z.literal('1').default('1'),
    githubIssue: z
      .object({
        url: z.string().url().max(2000).optional(),
        number: z.number().int().positive().optional(),
        title: z.string().min(1).max(500),
        body: z.string().max(100_000).default(''),
        labels: z.array(z.string().min(1).max(100)).max(50).optional(),
      })
      .strict(),
    prompt: z
      .object({
        promptId: z.string().min(1).max(200).optional(),
        effectivePrompt: z.string().min(1).max(100_000),
        systemPrompt: z.string().max(100_000).optional(),
      })
      .strict(),
    ai: z
      .object({
        provider: z.string().min(1).max(100),
        model: z.string().min(1).max(200),
        requestSummary: z.string().max(20_000).optional(),
        changeSummary: z.string().max(20_000).optional(),
      })
      .strict(),
    repository: z
      .object({
        host: z.string().min(1).max(200).optional(),
        owner: z.string().min(1).max(200).optional(),
        name: z.string().min(1).max(200),
        url: z.string().url().max(2000).optional(),
        defaultBranch: z.string().min(1).max(200).optional(),
      })
      .strict(),
    codeChange: z
      .object({
        filesChanged: z.array(fileChangeSchema).max(500).default([]),
        pullRequest: pullRequestSchema.optional(),
        commits: z.array(commitSchema).max(200).optional(),
      })
      .strict(),
    operationalNotes: z.string().max(20_000).optional(),
    errors: z.array(errorSchema).max(100).optional(),
    warnings: z.array(warningSchema).max(100).optional(),
    outcome: z
      .object({
        status: z.enum(outcomeStatuses),
        summary: z.string().max(10_000).optional(),
      })
      .strict(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    metadata: z.record(z.string(), z.string().max(2000)).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const metadata = value.metadata ?? {};
    const keys = Object.keys(metadata);
    if (keys.length > 30) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'metadata supports at most 30 keys', path: ['metadata'] });
    }
    for (const key of keys) {
      if (key.length < 1 || key.length > 100) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'metadata keys must be 1 to 100 characters', path: ['metadata', key] });
      }
    }
  });

export type ExecutionUpload = z.infer<typeof executionUploadSchema>;

export const executionUpdateSchema = z
  .object({
    ai: z
      .object({
        requestSummary: z.string().max(20_000).optional(),
        changeSummary: z.string().max(20_000).optional(),
      })
      .strict()
      .optional(),
    codeChange: z
      .object({
        filesChanged: z.array(fileChangeSchema).max(500).optional(),
        pullRequest: pullRequestSchema.nullable().optional(),
        commits: z.array(commitSchema).max(200).optional(),
      })
      .strict()
      .optional(),
    operationalNotes: z.string().max(20_000).nullable().optional(),
    errors: z.array(errorSchema).max(100).optional(),
    warnings: z.array(warningSchema).max(100).optional(),
    outcome: z
      .object({
        status: z.enum(outcomeStatuses),
        summary: z.string().max(10_000).optional(),
      })
      .strict()
      .optional(),
    completedAt: z.string().datetime().nullable().optional(),
    metadata: z.record(z.string(), z.string().max(2000)).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one field is required' });
    }
  });

export type ExecutionUpdate = z.infer<typeof executionUpdateSchema>;

const narrative = {
  whatWasDoneWell: z.string().max(20_000).optional(),
  missingInformation: z.string().max(20_000).optional(),
  ambiguous: z.string().max(20_000).optional(),
  couldBeWrittenBetter: z.string().max(20_000).optional(),
  recommendedImprovedPrompt: z.string().max(100_000).optional(),
  generalComments: z.string().max(20_000).optional(),
};

export const reviewDraftSchema = z
  .object({
    scores: partialScoresSchema.optional(),
    ...narrative,
  })
  .strict();

export const reviewSubmitSchema = z
  .object({
    scores: scoresSchema,
    ...narrative,
  })
  .strict();

export const needsInfoSchema = z
  .object({
    missingInformation: z.string().min(1).max(20_000),
    generalComments: z.string().max(20_000).optional(),
  })
  .strict();

const emailSchema = z.string().trim().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/, 'Invalid email');

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(200),
  })
  .strict();

export const createInstallationSchema = z
  .object({
    name: z.string().min(1).max(200),
    contactEmail: emailSchema.optional(),
  })
  .strict();

export const createUserSchema = z
  .object({
    email: emailSchema,
    name: z.string().min(1).max(200),
    password: z.string().min(12).max(200),
    role: z.enum(userRoles),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!/[A-Za-z]/.test(value.password) || !/[0-9]/.test(value.password)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Password must include a letter and a number',
      });
    }
  });

export const ackSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
  })
  .strict();

export const batchEnvelopeSchema = z
  .object({
    executions: z.array(z.unknown()).min(1).max(20),
  })
  .strict();

export const automatedEvaluationSchema = z
  .object({
    executionId: z.string().uuid(),
    evaluatorModel: z.string().min(1).max(200),
    scores: scoresSchema,
    whatWasDoneWell: z.string().max(20_000).optional(),
    missingInformation: z.string().max(20_000).optional(),
    ambiguous: z.string().max(20_000).optional(),
    couldBeWrittenBetter: z.string().max(20_000).optional(),
    recommendedImprovedPrompt: z.string().max(100_000).optional(),
    generalComments: z.string().max(20_000).optional(),
  })
  .strict();

export type AutomatedEvaluationInput = z.infer<typeof automatedEvaluationSchema>;

const FORBIDDEN_KEY =
  /^(authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|secrets|password|passwd|github[_-]?token|private[_-]?key|credentials|client[_-]?secret)$/i;

export function assertNoCredentialKeys(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new AppError(400, 'validation_error', `Field "${key}" is not accepted. Do not upload credentials.`, [
        { path: `${path}.${key}`, message: 'Credential fields are not accepted' },
      ]);
    }
    assertNoCredentialKeys(child, `${path}.${key}`);
  }
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      400,
      'validation_error',
      'Request validation failed',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function isCompleteScores(scores: PartialScores | undefined): scores is Scores {
  if (!scores) return false;
  return SCORE_KEYS.every((key) => {
    const value = scores[key];
    return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5;
  });
}

export function scoreAverage(scores: Scores): number {
  const sum = SCORE_KEYS.reduce((total, key) => total + scores[key], 0);
  return Math.round((sum / SCORE_KEYS.length) * 100) / 100;
}

export function repositoryKeyOf(owner: string | undefined, name: string): string {
  const normalizedName = name.trim().toLowerCase();
  const normalizedOwner = owner?.trim().toLowerCase() ?? '';
  return normalizedOwner ? `${normalizedOwner}/${normalizedName}` : normalizedName;
}
