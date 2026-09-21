import type {
  EvaluatorType,
  FeedbackDeliveryStatus,
  OutcomeStatus,
  PartialScores,
  ProcessingStatus,
  ReviewStatus,
  Scores,
  UserRole,
} from './domain.js';
import type { SecretFinding } from './security.js';

export type FileChange = {
  path: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  additions?: number;
  deletions?: number;
  previousPath?: string;
};

export type PullRequestInfo = {
  number?: number;
  url?: string;
  title?: string;
  state?: string;
};

export type CommitInfo = {
  sha: string;
  message: string;
  url?: string;
};

export type ExecutionMessage = {
  code?: string;
  message: string;
  severity?: 'error' | 'warning';
};

export type InstallationRecord = {
  installationId: string;
  name: string;
  contactEmail?: string;
  status: 'active' | 'disabled';
  apiKeyHash: string;
  apiKeyPrefix: string;
  createdAt: string;
  updatedAt: string;
};

export type UserRecord = {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  disabled: boolean;
  createdAt: string;
};

export type ExecutionRecord = {
  executionId: string;
  installationId: string;
  installationName: string;
  schemaVersion: string;
  contentHash: string;
  reviewStatus: ReviewStatus;
  processingStatus: ProcessingStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  supplementalUpdatedAt?: string;
  updatedAfterReview: boolean;
  repositoryKey: string;
  repositoryName: string;
  repositoryOwner: string;
  repositoryHost?: string;
  repositoryUrl?: string;
  defaultBranch?: string;
  issueTitle: string;
  issueNumber?: number;
  issueUrl?: string;
  issueBodyEnc: string;
  issueLabels: string[];
  promptId?: string;
  effectivePromptEnc: string;
  systemPromptEnc?: string;
  provider: string;
  model: string;
  requestSummary?: string;
  changeSummary?: string;
  operationalNotesEnc?: string;
  filesChanged: FileChange[];
  pullRequest?: PullRequestInfo;
  commits: CommitInfo[];
  errors: ExecutionMessage[];
  warnings: ExecutionMessage[];
  outcomeStatus: OutcomeStatus;
  outcomeSummary?: string;
  startedAt?: string;
  completedAt?: string;
  metadata: Record<string, string>;
  secretFindings: SecretFinding[];
  rawPayloadEnc: string;
  updateLogEnc: string[];
  assignedReviewerId?: string;
  reviewId?: string;
  automatedReviewId?: string;
  searchText: string;
};

export type PublishedReview = {
  version: number;
  scores: Scores;
  whatWasDoneWell: string;
  missingInformation: string;
  ambiguous: string;
  couldBeWrittenBetter: string;
  recommendedImprovedPromptEnc?: string;
  generalComments: string;
  submittedAt: string;
  reviewerId: string;
};

export type ReviewHistoryEntry = {
  version: number;
  submittedAt: string;
  reviewerId: string;
  overallScore: number;
  evaluatorType: EvaluatorType;
};

export type ReviewRecord = {
  reviewId: string;
  executionId: string;
  installationId: string;
  reviewerId: string;
  evaluatorType: EvaluatorType;
  evaluatorModel?: string;
  scoreSchemaVersion: number;
  status: 'draft' | 'submitted' | 'needs_more_information';
  scores: PartialScores;
  whatWasDoneWell?: string;
  missingInformation?: string;
  ambiguous?: string;
  couldBeWrittenBetter?: string;
  recommendedImprovedPromptEnc?: string;
  generalComments?: string;
  version: number;
  feedbackDeliveryStatus: FeedbackDeliveryStatus;
  acknowledgedAt?: string;
  acknowledgedVersion?: number;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  published?: PublishedReview;
  history: ReviewHistoryEntry[];
};

export type AuditRecord = {
  auditId: string;
  day: string;
  createdAt: string;
  actorType: 'user' | 'installation' | 'system';
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: 'success' | 'failure';
  ip?: string;
  metadata?: Record<string, string>;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export type ExecutionQuery = {
  installationId?: string;
  reviewStatus?: ReviewStatus;
  repositoryKey?: string;
  q?: string;
  limit: number;
  cursor?: string | null;
};

export type FeedbackQuery = {
  installationId: string;
  executionId?: string;
  deliveryStatus?: FeedbackDeliveryStatus;
  evaluatorType?: EvaluatorType;
  limit: number;
  cursor?: string | null;
};
