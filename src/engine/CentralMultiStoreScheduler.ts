import { JobRegistry, IJob, JobContext } from './JobRegistry';
import {
  ISyncPolicyRepository,
  SyncPolicy,
  SyncState
} from '../contracts/repositories';
import { IStoreResolutionService } from '../core/StoreResolutionService';
import { IDatabaseExecutor } from '../config/db';
import { ILogger, ConsoleLogger } from '../observability/Logger';
import { IClock, ISleeper, RealClock, RealSleeper } from '../utils/Clock';
import { StoreZeissContext } from '../contracts/store';
import { PgStoreSyncStateRepository } from '../repositories/postgres/StoreSyncStateRepository';
import { PgStoreSyncLeaseRepository } from '../repositories/postgres/StoreSyncLeaseRepository';
import { PgStoreProviderHealthRepository } from '../repositories/postgres/StoreProviderHealthRepository';
import { buildStoreCompositionRoot } from './StoreCompositionRoot';
import { SyncExecutionResult, ExecutePolicyOptions } from './Scheduler';
import { randomUUID } from 'crypto';

export interface CentralSchedulerDeps {
  globalPolicyRepo: ISyncPolicyRepository;
  storeResolutionService: IStoreResolutionService;
  db: IDatabaseExecutor;
  logger?: ILogger;
  clock?: IClock;
  sleeper?: ISleeper;
}

export interface StoreExecutionOutcome {
  storeId: string;
  storeCode: string;
  provider: string;
  domain: string;
  operation: string;
  result: SyncExecutionResult;
  error?: string;
}

export interface CentralSchedulerTickResult {
  totalPolicies: number;
  totalActiveStores: number;
  executions: StoreExecutionOutcome[];
}

/**
 * Central Multi-Store Scheduler — BD_API_ZEISS Platform
 * 
 * Enforces the canonical rule:
 * "Não existe mapa de sincronização individual por loja."
 * 
 * 1. Policy Map is 100% centralized (integration.sync_policies).
 * 2. Active stores participate in the central schedule dynamically.
 * 3. Execution state, checkpoints, leases, and health are 100% segregated per store.
 * 4. Error in Store A never blocks Store B.
 * 5. Concurrent executions of the same job on the same store are prevented via atomic leases.
 */
export class CentralMultiStoreScheduler {
  private readonly workerId: string = randomUUID();
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly sleeper: ISleeper;

  constructor(private deps: CentralSchedulerDeps) {
    this.logger = deps.logger || new ConsoleLogger();
    this.clock = deps.clock || new RealClock();
    this.sleeper = deps.sleeper || new RealSleeper();
  }

  async tick(provider = 'zeiss'): Promise<CentralSchedulerTickResult> {
    // 1. Read central versioned policies (Single source of truth)
    const policies = await this.deps.globalPolicyRepo.findEnabledByProvider(provider);
    this.logger.info('CentralScheduler', `Read ${policies.length} enabled central policies for provider '${provider}'`);

    // 2. Discover dynamically all eligible and active stores
    const allStores = await this.deps.storeResolutionService.listEligibleStores();
    // Only 'active' stores participate in the recurring schedule
    const activeStores = allStores.filter(s => s.status === 'active');
    this.logger.info('CentralScheduler', `Discovered ${activeStores.length} active store(s) out of ${allStores.length} eligible`);

    const executions: StoreExecutionOutcome[] = [];

    // 3. For each central policy, execute for all active stores with segregated state
    for (const policy of policies) {
      for (const store of activeStores) {
        try {
          const result = await this.executeStorePolicy(store, policy, { force: false, allowDisabled: false });
          if (result) {
            executions.push({
              storeId: store.storeId,
              storeCode: store.storeCode,
              provider: policy.provider,
              domain: policy.domain,
              operation: policy.operation,
              result
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error('CentralScheduler', `Unexpected error ticking store ${store.storeCode} on ${policy.domain}:${policy.operation}`, {
            storeId: store.storeId,
            error: msg
          });
          executions.push({
            storeId: store.storeId,
            storeCode: store.storeCode,
            provider: policy.provider,
            domain: policy.domain,
            operation: policy.operation,
            result: 'EXECUTED_FAILED',
            error: msg
          });
          // Non-blocking: failure in Store A never stops Store B
        }
      }
    }

    return {
      totalPolicies: policies.length,
      totalActiveStores: activeStores.length,
      executions
    };
  }

  async executeOperation(
    storeIdentifier: string,
    provider: string,
    domain: string,
    operation: string,
    options?: ExecutePolicyOptions
  ): Promise<SyncExecutionResult> {
    const store = await this.deps.storeResolutionService.resolveStore(storeIdentifier);

    // Read central policy for this operation
    const policy = await this.deps.globalPolicyRepo.findByKey(provider, domain, operation);
    if (!policy) {
      this.logger.error('CentralScheduler', 'Central policy not found for operation', { provider, domain, operation });
      return 'CONFIGURATION_ERROR';
    }

    const result = await this.executeStorePolicy(store, policy, {
      ...options,
      force: options?.force ?? true
    });

    return result || 'CONFIGURATION_ERROR';
  }

  public async executeStorePolicy(
    store: StoreZeissContext,
    policy: SyncPolicy,
    options?: ExecutePolicyOptions
  ): Promise<SyncExecutionResult | null> {
    const { provider, domain, operation } = policy;
    const loggerCtx = { storeId: store.storeId, storeCode: store.storeCode, provider, domain, operation };

    // Check central policy validity
    if (policy.interval_seconds <= 0 || policy.timeout_seconds <= 0 || policy.lease_ttl_seconds <= 0 || policy.max_retries < 0 || policy.retry_delay_seconds < 0) {
      this.logger.error('CentralScheduler', 'Invalid central policy configuration', loggerCtx);
      return 'CONFIGURATION_ERROR';
    }

    // Check enabled
    if (!policy.enabled && !options?.allowDisabled) {
      this.logger.warn('CentralScheduler', 'Central policy is disabled; skipping execution', loggerCtx);
      return 'SKIPPED_DISABLED';
    }

    // Store-isolated State, Lease, and Health repositories
    const stateRepo = new PgStoreSyncStateRepository(this.deps.db, store.storeId);
    const leaseRepo = new PgStoreSyncLeaseRepository(this.deps.db, store.storeId);
    const healthRepo = new PgStoreProviderHealthRepository(this.deps.db, store.storeId);

    // 1. Check if due for this store (using central interval and store checkpoint)
    let storeState = await stateRepo.findByKey(provider, domain, operation);

    // Bootstrap handoff: if orders continuous discovery has no cursor, check if orders bootstrap completed
    if (domain === 'orders' && operation === 'discovery' && (!storeState || !storeState.cursor_value)) {
      const bootstrapState = await stateRepo.findByKey(provider, 'orders', 'bootstrap');
      if (bootstrapState && bootstrapState.cursor_value) {
        try {
          const bCursor = typeof bootstrapState.cursor_value === 'string'
            ? JSON.parse(bootstrapState.cursor_value)
            : bootstrapState.cursor_value;
          if (bCursor && bCursor.lastCompletedDate) {
            storeState = {
              provider,
              domain,
              operation,
              last_sync: bootstrapState.last_sync || new Date(this.clock.now()),
              cursor_value: JSON.stringify({ lastEndDate: bCursor.lastCompletedDate })
            };
            this.logger.info('CentralScheduler', `Seeded orders discovery cursor from completed bootstrap checkpoint: ${bCursor.lastCompletedDate}`, loggerCtx);
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    // Bootstrap handoff: if receivables sync has no cursor, check if financial bootstrap completed
    if ((domain === 'receivables' || domain === 'financial') && operation === 'sync' && (!storeState || !storeState.cursor_value)) {
      const bootstrapState = await stateRepo.findByKey(provider, 'financial', 'bootstrap');
      if (bootstrapState && bootstrapState.cursor_value) {
        try {
          const bCursor = typeof bootstrapState.cursor_value === 'string'
            ? JSON.parse(bootstrapState.cursor_value)
            : bootstrapState.cursor_value;
          if (bCursor && bCursor.lastCompletedDate) {
            storeState = {
              provider,
              domain,
              operation,
              last_sync: bootstrapState.last_sync || new Date(this.clock.now()),
              cursor_value: JSON.stringify({ lastEndDate: bCursor.lastCompletedDate })
            };
            this.logger.info('CentralScheduler', `Seeded receivables cursor from completed bootstrap checkpoint: ${bCursor.lastCompletedDate}`, loggerCtx);
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    if (!options?.force && !this.isDue(policy, storeState)) {
      this.logger.debug('CentralScheduler', 'Policy not due for store, skipping', loggerCtx);
      return 'SKIPPED_NOT_DUE';
    }

    // 2. Try acquiring atomic lease for this store
    const { acquired } = await leaseRepo.tryAcquire(
      provider,
      domain,
      operation,
      this.workerId,
      policy.lease_ttl_seconds
    );

    if (!acquired) {
      this.logger.debug('CentralScheduler', 'Lease unavailable for store, skipping', loggerCtx);
      return 'SKIPPED_LEASE';
    }

    // 3. Keepalive setup (interruptible sleep to prevent lingering on job finish)
    const keepaliveInterval = Math.max(1000, (policy.lease_ttl_seconds / 2) * 1000);
    let ownershipLost = false;
    let keepaliveActive = true;

    const runKeepalive = async () => {
      while (keepaliveActive) {
        const sleepChunk = 1000;
        let elapsed = 0;
        while (keepaliveActive && elapsed < keepaliveInterval) {
          await this.sleeper.sleep(sleepChunk);
          elapsed += sleepChunk;
        }
        if (!keepaliveActive) break;
        try {
          const renewed = await leaseRepo.renew(provider, domain, operation, this.workerId, policy.lease_ttl_seconds);
          if (!renewed) {
            ownershipLost = true;
            this.logger.error('CentralScheduler', 'Lost lease ownership during execution for store', loggerCtx);
            break;
          }
        } catch {
          ownershipLost = true;
          break;
        }
      }
    };

    const keepalivePromise = runKeepalive();

    // 4. Execution phase
    try {
      this.logger.info('CentralScheduler', 'Acquired lease, starting job for store', loggerCtx);

      // Build store-scoped composition root
      const root = buildStoreCompositionRoot(this.deps.db, store, this.logger, this.clock, this.sleeper);
      const job = root.registry.get(provider, domain, operation);

      if (!job) {
        this.logger.error('CentralScheduler', 'Job not found in registry', loggerCtx);
        throw new Error(`Missing job for ${provider}:${domain}:${operation}`);
      }

      // Execute job with retries
      const result = await this.executeWithRetry(job, storeState, policy, () => ownershipLost);

      // 5. Update State and Health
      if (ownershipLost) {
        this.logger.error('CentralScheduler', 'Job completed but lease ownership was lost. State not advanced.', loggerCtx);
        await healthRepo.recordFailure(provider, domain, operation);
        return 'EXECUTED_FAILED';
      }

      if (result.success) {
        const stillOwner = await leaseRepo.renew(provider, domain, operation, this.workerId, policy.lease_ttl_seconds).catch(() => false);
        if (!stillOwner) {
          this.logger.error('CentralScheduler', 'Lost lease ownership prior to state advancement', loggerCtx);
          await healthRepo.recordFailure(provider, domain, operation);
          return 'EXECUTED_FAILED';
        }

        await healthRepo.recordSuccess(provider, domain, operation);
        await stateRepo.upsert({
          provider,
          domain,
          operation,
          last_sync: new Date(this.clock.now()),
          cursor_value: result.cursorValue !== undefined ? result.cursorValue : (storeState?.cursor_value || null)
        });

        this.logger.info('CentralScheduler', 'Job completed successfully for store', { ...loggerCtx, metrics: result.metrics });
        return 'EXECUTED_SUCCESS';
      } else {
        await healthRepo.recordFailure(provider, domain, operation);
        this.logger.error('CentralScheduler', 'Job failed for store', { ...loggerCtx, error: result.error?.message });
        return 'EXECUTED_FAILED';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await healthRepo.recordFailure(provider, domain, operation);
      this.logger.error('CentralScheduler', 'Fatal execution error for store', { ...loggerCtx, error: msg });
      if (msg.startsWith('Missing job for')) {
        return 'CONFIGURATION_ERROR';
      }
      return 'EXECUTED_FAILED';
    } finally {
      keepaliveActive = false;
      await keepalivePromise.catch(() => {});
      if (!ownershipLost) {
        await leaseRepo.release(provider, domain, operation, this.workerId).catch(() => {});
        this.logger.debug('CentralScheduler', 'Released lease for store', loggerCtx);
      }
    }
  }

  private isDue(policy: SyncPolicy, state: SyncState | null): boolean {
    if (!state || !state.last_sync) return true;
    const now = this.clock.now();
    const lastSyncTime = new Date(state.last_sync).getTime();
    const elapsedSeconds = (now - lastSyncTime) / 1000;
    return elapsedSeconds >= policy.interval_seconds;
  }

  private async executeWithRetry(
    job: IJob,
    state: SyncState | null,
    policy: SyncPolicy,
    isLost: () => boolean
  ) {
    let attempts = 0;
    const maxAttempts = 1 + policy.max_retries;

    while (attempts < maxAttempts) {
      attempts++;
      if (isLost()) {
        return { success: false, retryable: false, error: new Error('Lease ownership lost before attempt') };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), policy.timeout_seconds * 1000);

      const jobCtx: JobContext = {
        lastSyncState: state,
        policy,
        abortSignal: controller.signal,
        provider: policy.provider,
        domain: policy.domain,
        operation: policy.operation,
      };

      try {
        const result = await job.execute(jobCtx);
        clearTimeout(timer);

        if (result.success || !result.retryable || attempts >= maxAttempts) {
          return result;
        }

        this.logger.warn('CentralScheduler', `Job attempt ${attempts} failed; retrying in ${policy.retry_delay_seconds}s`, {
          error: result.error?.message
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempts >= maxAttempts) {
          return { success: false, retryable: false, error: err instanceof Error ? err : new Error(String(err)) };
        }
      }

      if (isLost()) {
        return { success: false, retryable: false, error: new Error('Lease ownership lost during retry delay') };
      }

      await this.sleeper.sleep(policy.retry_delay_seconds * 1000);
    }

    return { success: false, retryable: false, error: new Error('Exhausted all retries') };
  }
}
