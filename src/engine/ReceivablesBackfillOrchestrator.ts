import { IReceivablesProvider } from '../contracts/providers';
import { IReceivablesRepository, ISyncPolicyRepository, ISyncStateRepository, ISyncLeaseRepository } from '../contracts/repositories';
import { ILogger } from '../observability/Logger';
import { IClock } from '../utils/Clock';
import { ReceivablesSyncJob } from './jobs/ReceivablesSyncJob';
import { JobContext } from './JobRegistry';

export interface ReceivablesBackfillOrchestratorDeps {
  provider: IReceivablesProvider;
  repo: IReceivablesRepository;
  policyRepo: ISyncPolicyRepository;
  stateRepo: ISyncStateRepository;
  leaseRepo: ISyncLeaseRepository;
  logger: ILogger;
  clock: IClock;
  workerId: string;
}

export class ReceivablesBackfillOrchestrator {
  constructor(private deps: ReceivablesBackfillOrchestratorDeps) {}

  async run(maxWindows: number): Promise<{ success: boolean; windowsProcessed: number; finalCursor: string; totalSynced: number; totalErrors: number }> {
    const { logger, workerId, policyRepo, leaseRepo, stateRepo, clock, provider, repo } = this.deps;
    const providerName = 'zeiss';
    const domainName = 'receivables';
    const operationName = 'sync';

    let windowsProcessed = 0;
    let totalSynced = 0;
    let totalErrors = 0;
    let currentCursor = '';
    let keepaliveTimer: NodeJS.Timeout | null = null;
    let ownershipLost = false;

    try {
      const policy = await policyRepo.findByKey(providerName, domainName, operationName);
      if (!policy || !policy.enabled) {
        logger.error('backfill-receivables', 'Receivables sync policy is not enabled or not found', { policyEnabled: policy?.enabled });
        return { success: false, windowsProcessed, finalCursor: currentCursor, totalSynced, totalErrors };
      }

      const acquisition = await leaseRepo.tryAcquire(providerName, domainName, operationName, workerId, policy.lease_ttl_seconds);
      if (!acquisition.acquired) {
        logger.error('backfill-receivables', 'Could not acquire lease', { acquisition });
        return { success: false, windowsProcessed, finalCursor: currentCursor, totalSynced, totalErrors };
      }

      keepaliveTimer = setInterval(async () => {
        if (ownershipLost) return;
        try {
          const renewed = await leaseRepo.renew(providerName, domainName, operationName, workerId, policy.lease_ttl_seconds);
          if (!renewed) ownershipLost = true;
        } catch {
          ownershipLost = true;
        }
      }, Math.floor((policy.lease_ttl_seconds / 2) * 1000));

      const receivablesSyncJob = new ReceivablesSyncJob(provider, repo, logger, clock);

      let loopSuccess = true;
      for (let i = 0; i < maxWindows; i++) {
        if (ownershipLost) {
          logger.error('backfill-receivables', 'Stopping loop due to lost lease', { windowIndex: i });
          loopSuccess = false;
          break;
        }

        const state = await stateRepo.findByKey(providerName, domainName, operationName);
        if (!state || !state.cursor_value) {
          logger.error('backfill-receivables', 'No valid cursor found. Bootstrap required.', { stateExists: !!state });
          loopSuccess = false;
          break;
        }

        const cursorObj = JSON.parse(state.cursor_value);
        const lastEndDateStr = cursorObj.lastEndDate;
        if (!lastEndDateStr) {
          logger.error('backfill-receivables', 'Corrupted cursor, missing lastEndDate', { cursorObj });
          loopSuccess = false;
          break;
        }

        currentCursor = lastEndDateStr;
        const lastEnd = new Date(lastEndDateStr);
        const today = new Date(clock.now());

        if (lastEnd.getTime() >= today.getTime() || (lastEnd.toISOString().split('T')[0] === today.toISOString().split('T')[0])) {
          logger.info('backfill-receivables', `Reached today's date (${lastEndDateStr}). Stopping backfill.`);
          break;
        }

        const controller = new AbortController();
        const context: JobContext = {
          provider: providerName,
          domain: domainName,
          operation: operationName,
          abortSignal: controller.signal,
          lastSyncState: state,
          policy,
        };

        const result = await receivablesSyncJob.execute(context);

        if (!result.success) {
          logger.error('backfill-receivables', 'Window failed during ReceivablesSyncJob execution', { error: result.error?.message });
          if (result.metrics) {
            totalSynced += result.metrics.synced || 0;
            totalErrors += result.metrics.errors || 0;
          }
          loopSuccess = false;
          break; // Stop immediately on failure
        }

        const stillOwner = await leaseRepo.renew(providerName, domainName, operationName, workerId, policy.lease_ttl_seconds).catch(() => false);
        if (!stillOwner) {
          ownershipLost = true;
          logger.error('backfill-receivables', 'Lost lease ownership prior to state advancement', { windowIndex: i });
          loopSuccess = false;
          break;
        }

        const newCursor = result.cursorValue || state.cursor_value;
        await stateRepo.upsert({
          provider: providerName,
          domain: domainName,
          operation: operationName,
          last_sync: new Date(clock.now()),
          cursor_value: newCursor
        });

        windowsProcessed++;
        if (result.metrics) {
          totalSynced += result.metrics.synced || 0;
          totalErrors += result.metrics.errors || 0;
        }
        currentCursor = newCursor;
      }

      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (!ownershipLost) {
        await leaseRepo.release(providerName, domainName, operationName, workerId);
      }

      return { success: loopSuccess, windowsProcessed, finalCursor: currentCursor, totalSynced, totalErrors };
    } catch (err) {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error('backfill-receivables', 'Fatal exception caught in orchestrator', { error: errorMessage, stack });
      return { success: false, windowsProcessed, finalCursor: currentCursor, totalSynced, totalErrors };
    }
  }
}
