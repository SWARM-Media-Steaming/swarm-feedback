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

export interface InstallationRepo {
  create(record: InstallationRecord): Promise<void>;
  get(id: string): Promise<InstallationRecord | null>;
  list(): Promise<InstallationRecord[]>;
  findByPrefix(prefix: string): Promise<InstallationRecord[]>;
  update(record: InstallationRecord): Promise<void>;
}

export interface UserRepo {
  create(record: UserRecord): Promise<void>;
  get(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  list(): Promise<UserRecord[]>;
}

export interface ExecutionRepo {
  create(record: ExecutionRecord): Promise<'created' | 'exists'>;
  get(id: string): Promise<ExecutionRecord | null>;
  compareAndSwap(expectedRevision: number, next: ExecutionRecord): Promise<boolean>;
  query(params: ExecutionQuery): Promise<Page<ExecutionRecord>>;
}

export interface ReviewRepo {
  create(record: ReviewRecord): Promise<void>;
  get(id: string): Promise<ReviewRecord | null>;
  save(record: ReviewRecord): Promise<void>;
  listByExecution(executionId: string): Promise<ReviewRecord[]>;
  queryByInstallation(params: FeedbackQuery): Promise<Page<ReviewRecord>>;
}

export interface AuditRepo {
  put(record: AuditRecord): Promise<void>;
  listRecent(limit: number): Promise<AuditRecord[]>;
}

export interface HealthRepo {
  ready(): Promise<boolean>;
}

export type Repositories = {
  installations: InstallationRepo;
  users: UserRepo;
  executions: ExecutionRepo;
  reviews: ReviewRepo;
  audit: AuditRepo;
  health: HealthRepo;
};
