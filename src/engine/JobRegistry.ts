import { SyncState, SyncPolicy } from '../contracts/repositories';

export interface JobResult {
  success: boolean;
  retryable: boolean;
  cursorValue?: string | null;
  metrics?: Record<string, number>;
  error?: Error;
}

export interface JobContext {
  lastSyncState?: SyncState | null;
  policy: SyncPolicy;
  abortSignal: AbortSignal;
  provider: string;
  domain: string;
  operation: string;
}

export interface IJob {
  execute(context: JobContext): Promise<JobResult>;
}

export type JobKey = `${string}:${string}:${string}`;

export class JobRegistry {
  private jobs = new Map<JobKey, IJob>();

  register(provider: string, domain: string, operation: string, job: IJob): void {
    const key = JobRegistry.makeKey(provider, domain, operation);
    this.jobs.set(key, job);
  }

  get(provider: string, domain: string, operation: string): IJob | undefined {
    const key = JobRegistry.makeKey(provider, domain, operation);
    return this.jobs.get(key);
  }

  static makeKey(provider: string, domain: string, operation: string): JobKey {
    return `${provider}:${domain}:${operation}`;
  }
}
