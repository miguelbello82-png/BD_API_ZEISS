import { JobRegistry, JobContext, JobResult, IJob } from './JobRegistry';
import {
  ISyncPolicyRepository,
  ISyncStateRepository,
  ISyncLeaseRepository,
  IProviderHealthRepository,
  SyncPolicy,
  SyncState
} from '../contracts/repositories';
import { ILogger } from '../observability/Logger';
import { randomUUID } from 'crypto';
import { IClock, ISleeper } from '../utils/Clock';

export interface SchedulerDeps {
  policyRepo: ISyncPolicyRepository;
  stateRepo: ISyncStateRepository;
  leaseRepo: ISyncLeaseRepository;
  healthRepo: IProviderHealthRepository;
  jobRegistry: JobRegistry;
  logger: ILogger;
  clock: IClock;
  sleeper: ISleeper;
}

export class Scheduler {
  private readonly workerId: string = randomUUID();

  constructor(private deps: SchedulerDeps) {}

  async tick(provider?: string): Promise<void> {
    const policies = provider 
      ? await this.deps.policyRepo.findEnabledByProvider(provider)
      : await this.deps.policyRepo.findAllEnabled(); // Must not default to zeiss! Add findAllEnabled to repo

    for (const policy of policies) {
      await this.evaluatePolicy(policy);
    }
  }

  private async evaluatePolicy(policy: SyncPolicy): Promise<void> {
    const { provider, domain, operation } = policy;
    const loggerCtx = { provider, domain, operation };

    // Validate Policy Config
    if (policy.interval_seconds <= 0 || policy.timeout_seconds <= 0 || policy.lease_ttl_seconds <= 0 || policy.max_retries < 0 || policy.retry_delay_seconds < 0) {
      this.deps.logger.error('Scheduler', 'Invalid policy configuration', loggerCtx);
      await this.deps.healthRepo.recordFailure(provider, domain, operation);
      return;
    }

    const envelopeSeconds = ((1 + policy.max_retries) * policy.timeout_seconds) + (policy.max_retries * policy.retry_delay_seconds);
    if (policy.lease_ttl_seconds < envelopeSeconds) {
      this.deps.logger.error('Scheduler', 'Policy lease TTL is smaller than execution envelope', { ...loggerCtx, envelopeSeconds, leaseTtl: policy.lease_ttl_seconds });
      await this.deps.healthRepo.recordFailure(provider, domain, operation);
      return;
    }

    // 1. Determine if due
    const state = await this.deps.stateRepo.findByKey(provider, domain, operation);
    if (!this.isDue(policy, state)) {
      return;
    }

    // 2. Try lease
    const { acquired } = await this.deps.leaseRepo.tryAcquire(
      provider,
      domain,
      operation,
      this.workerId,
      policy.lease_ttl_seconds
    );

    if (!acquired) {
      this.deps.logger.debug('Scheduler', 'Lease unavailable, skipping', loggerCtx);
      return; 
    }

    // 3. Keepalive setup
    // We renew at half the TTL to ensure safety.
    const keepaliveInterval = Math.max(1000, (policy.lease_ttl_seconds / 2) * 1000);
    let ownershipLost = false;
    let keepaliveActive = true;

    const runKeepalive = async () => {
      while (keepaliveActive) {
        await this.deps.sleeper.sleep(keepaliveInterval);
        if (!keepaliveActive) break;
        try {
          const renewed = await this.deps.leaseRepo.renew(provider, domain, operation, this.workerId, policy.lease_ttl_seconds);
          if (!renewed) {
            ownershipLost = true;
            this.deps.logger.error('Scheduler', 'Lost lease ownership during execution', loggerCtx);
            break; // Stop keepalive if lost
          }
        } catch (err) {
          ownershipLost = true;
          this.deps.logger.error('Scheduler', 'Failed to renew lease (exception)', { ...loggerCtx, error: String(err) });
          break; // Treat exception as lost ownership
        }
      }
    };
    
    // start keepalive loop
    const keepalivePromise = runKeepalive();

    // 4. Execution Phase
    try {
      this.deps.logger.info('Scheduler', 'Acquired lease, starting job', loggerCtx);
      const job = this.deps.jobRegistry.get(provider, domain, operation);
      
      if (!job) {
        this.deps.logger.error('Scheduler', 'Job not found in registry', loggerCtx);
        throw new Error(`Missing job for ${provider}:${domain}:${operation}`);
      }

      const result = await this.executeWithRetry(job, state, policy, () => ownershipLost);

      // 5. Update State and Health
      if (ownershipLost) {
        this.deps.logger.error('Scheduler', 'Job completed or failed but ownership was lost. State will not be advanced.', loggerCtx);
        await this.deps.healthRepo.recordFailure(provider, domain, operation);
      } else if (result.success) {
        // Explicitly prove current lease ownership again before state advancement
        const stillOwner = await this.deps.leaseRepo.renew(provider, domain, operation, this.workerId, policy.lease_ttl_seconds).catch(() => false);
        if (!stillOwner) {
          this.deps.logger.error('Scheduler', 'Lost lease ownership prior to state advancement', loggerCtx);
          await this.deps.healthRepo.recordFailure(provider, domain, operation);
        } else {
          await this.deps.healthRepo.recordSuccess(provider, domain, operation);
          await this.deps.stateRepo.upsert({
            provider,
            domain,
            operation,
            last_sync: new Date(this.deps.clock.now()),
            cursor_value: result.cursorValue !== undefined ? result.cursorValue : (state?.cursor_value || null)
          });
          this.deps.logger.info('Scheduler', 'Job completed successfully', { ...loggerCtx, metrics: result.metrics });
        }
      } else {
        await this.deps.healthRepo.recordFailure(provider, domain, operation);
        this.deps.logger.error('Scheduler', 'Job failed', { ...loggerCtx, error: result.error?.message });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.deps.healthRepo.recordFailure(provider, domain, operation);
      this.deps.logger.error('Scheduler', 'Fatal execution error', { ...loggerCtx, error: msg });
    } finally {
      keepaliveActive = false;
      // We don't await keepalivePromise here because sleeper might be blocking, it will safely exit when it wakes.
      // 6. Release lease safely
      await this.deps.leaseRepo.release(provider, domain, operation, this.workerId);
      this.deps.logger.debug('Scheduler', 'Lease released', loggerCtx);
    }
  }

  private isDue(policy: SyncPolicy, state: SyncState | null): boolean {
    if (!state || !state.last_sync) return true;
    
    const now = this.deps.clock.now();
    const lastSyncTime = state.last_sync.getTime();
    const intervalMs = policy.interval_seconds * 1000;
    
    return (now - lastSyncTime) >= intervalMs;
  }

  private async executeWithRetry(job: IJob, state: SyncState | null, policy: SyncPolicy, getOwnershipLost: () => boolean): Promise<JobResult> {
    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt <= policy.max_retries) {
      if (getOwnershipLost()) {
        return { success: false, retryable: false, error: new Error('Ownership lost before retry') };
      }
      attempt++;
      
      const abortController = new AbortController();
      let timeoutHandle: NodeJS.Timeout | undefined;
      let executePromise: Promise<JobResult> | undefined;

      try {
        const timeoutPromise = new Promise<JobResult>((_, reject) => 
          timeoutHandle = setTimeout(() => {
            abortController.abort(new Error('Operation timed out'));
            reject(new Error('Operation timed out'));
          }, policy.timeout_seconds * 1000)
        );
        
        timeoutPromise.catch(() => {});
        
        const context: JobContext = { 
          provider: policy.provider, 
          domain: policy.domain, 
          operation: policy.operation, 
          lastSyncState: state,
          policy,
          abortSignal: abortController.signal
        };

        executePromise = job.execute(context);
        
        // Wait for race. If timeout wins, executePromise might still be running and must respect abortSignal
        const result = await Promise.race([executePromise, timeoutPromise]);
        
        // If we get here, it succeeded or failed properly without timing out
        if (timeoutHandle) clearTimeout(timeoutHandle);
        
        if (result.success) {
          return result;
        }

        if (!result.retryable) {
          return result;
        }

        lastError = result.error || new Error('Job returned success=false with retryable=true');
        this.deps.logger.warn('Scheduler', `Attempt ${attempt} failed`, { error: lastError.message });
      } catch (err: unknown) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        const errObj = err instanceof Error ? err : new Error(String(err));
        lastError = errObj;
        
        this.deps.logger.warn('Scheduler', `Attempt ${attempt} threw`, { error: errObj.message });

        // If it was a timeout (or another exception), we MUST wait for the job to settle 
        // to prevent zombie execution overlapping with retries.
        if (executePromise) {
          try {
            await executePromise;
          } catch (e) {
            // Ignore errors from the aborted job, we already caught the timeout
          }
        }
      }
      
      if (attempt <= policy.max_retries) {
        await this.deps.sleeper.sleep(policy.retry_delay_seconds * 1000);
      }
    }

    return { success: false, retryable: false, error: lastError || new Error('Max retries exhausted') };
  }
}
