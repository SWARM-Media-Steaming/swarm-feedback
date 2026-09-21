export type Role = 'administrator' | 'reviewer';
export type ReviewStatus = 'pending' | 'in_review' | 'completed' | 'needs_more_information';

export type User = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
};

export type ScoreKey =
  | 'promptClarity'
  | 'promptCompleteness'
  | 'contextQuality'
  | 'technicalSpecificity'
  | 'constraintQuality'
  | 'intentUnderstanding'
  | 'implementationQuality'
  | 'efficiency'
  | 'overallPromptQuality';

export const SCORE_FIELDS: Array<[ScoreKey, string, string]> = [
  ['promptClarity', 'Prompt clarity', 'The request is understandable without guessing.'],
  ['promptCompleteness', 'Prompt completeness', 'The outcome, inputs, and done state are present.'],
  ['contextQuality', 'Context quality', 'Issue and repository context are enough to start.'],
  ['technicalSpecificity', 'Technical specificity', 'Files, interfaces, and acceptance details are concrete.'],
  ['constraintQuality', 'Constraint quality', 'Limits and non-goals are explicit.'],
  ['intentUnderstanding', 'Intent understanding', 'How likely the model understood the requester.'],
  ['implementationQuality', 'Implementation quality', 'The change matches the issue.'],
  ['efficiency', 'Efficiency', 'The work avoids unnecessary churn.'],
  ['overallPromptQuality', 'Overall prompt quality', 'Your overall judgment. This is the overall score returned to the owner.'],
];

export type QueueItem = {
  executionId: string;
  installationId: string;
  installationName: string;
  reviewStatus: ReviewStatus;
  repositoryKey: string;
  repositoryName: string;
  issueTitle: string;
  issueNumber: number | null;
  provider: string;
  model: string;
  outcomeStatus: string;
  createdAt: string;
  assignedReviewerId: string | null;
  secretFindingCount: number;
  supplementalUpdatedAt: string | null;
};

export type ExecutionDetail = {
  executionId: string;
  installationId: string;
  installationName: string;
  revision: number;
  reviewStatus: ReviewStatus;
  processingStatus: string;
  createdAt: string;
  updatedAt: string;
  supplementalUpdatedAt: string | null;
  updatedAfterReview: boolean;
  assignedReviewerId: string | null;
  secretFindings: Array<{ type: string; path: string }>;
  githubIssue: { title: string; body: string; number: number | null; url: string | null; labels: string[] };
  prompt: { promptId: string | null; effectivePrompt: string; systemPrompt: string | null };
  ai: { provider: string; model: string; requestSummary: string | null; changeSummary: string | null };
  repository: { key: string; name: string; owner: string | null; url: string | null; defaultBranch: string | null };
  codeChange: {
    filesChanged: Array<{ path: string; changeType: string; additions?: number; deletions?: number }>;
    pullRequest: { number?: number; url?: string; title?: string; state?: string } | null;
    commits: Array<{ sha: string; message: string; url?: string }>;
  };
  operationalNotes: string | null;
  errors: Array<{ code?: string; message: string; severity?: string }>;
  warnings: Array<{ code?: string; message: string }>;
  outcome: { status: string; summary: string | null };
  startedAt: string | null;
  completedAt: string | null;
  metadata: Record<string, string>;
};

export type ReviewDraft = {
  reviewId: string;
  status: string;
  scores: Partial<Record<ScoreKey, number>>;
  whatWasDoneWell: string;
  missingInformation: string;
  ambiguous: string;
  couldBeWrittenBetter: string;
  recommendedImprovedPrompt: string;
  generalComments: string;
  version: number;
  feedbackDeliveryStatus: string;
};

export type Installation = {
  installationId: string;
  name: string;
  status: string;
  contactEmail?: string | null;
  apiKeyPrefix?: string;
  createdAt?: string;
};
