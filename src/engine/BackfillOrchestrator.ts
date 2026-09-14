import { IOrdersRepository, IOrderDetailsRepository, ISyncPolicyRepository, ISyncStateRepository, ISyncLeaseRepository } from '../contracts/repositories';
import { IOrdersListProvider, IOrderDetailProvider } from '../contracts/providers';
import { ILogger } from '../observability/Logger';
import { IClock } from '../utils/Clock';
import { OrdersSync } from './OrdersSync';
import { JobContext } from './JobRegistry';
import { IOrderClassifier } from './Classifiers';

export interface BackfillOrchestratorDeps {
  ordersProvider: IOrdersListProvider;
  detailProvider: IOrderDetailProvider;
  ordersRepo: IOrdersRepository;
  detailsRepo: IOrderDetailsRepository;
  policyRepo: ISyncPolicyRepository;
  stateRepo: ISyncStateRepository;
  leaseRepo: ISyncLeaseRepository;
  classifier: IOrderClassifier;
  logger: ILogger;
  clock: IClock;
  workerId: string;
}

export class BackfillOrchestrator {
  constructor(private deps: BackfillOrchestratorDeps) {}

  async run(maxWindows: number): Promise<{ success: boolean; windowsProcessed: number; finalCursor: string; totalDiscovered: number; totalHydrated: number; totalErrors: number }> {
    const { logger, workerId, policyRepo, leaseRepo, stateRepo, clock } = this.deps;
    const providerName = 'zeiss';
    const domainName = 'orders';
    const operationName = 'discovery';

    let windowsProcessed = 0;
    let totalDiscovered = 0;
    let totalHydrated = 0;
    let totalErrors = 0;
    let currentCursor = '';
    let keepaliveTimer: NodeJS.Timeout | null = null;
    let ownershipLost = false;

    try {
      const policy = await policyRepo.findByKey(providerName, domainName, operationName);
      if (!policy || !policy.enabled) {
        logger.error('backfill', 'Orders discovery policy is not enabled or not found', { policyEnabled: policy?.enabled });
        return { success: false, windowsProcessed, finalCursor: currentCursor, totalDiscovered, totalHydrated, totalErrors };
      }

      const acquisition = await leaseRepo.tryAcquire(providerName, domainName, operationName, workerId, policy.lease_ttl_seconds);
      if (!acquisition.acquired) {
        logger.error('backfill', 'Could not acquire lease', { acquisition });
        return { success: false, windowsProcessed, finalCursor: currentCursor, totalDiscovered, totalHydrated, totalErrors };
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

      const ordersSync = new OrdersSync({
        ordersProvider: this.deps.ordersProvider,
        detailProvider: this.deps.detailProvider,
        ordersRepo: this.deps.ordersRepo,
        detailsRepo: this.deps.detailsRepo,
        classifier: this.deps.classifier,
        logger: this.deps.logger,
        clock: this.deps.clock
      });

      let loopSuccess = true;
      for (let i = 0; i < maxWindows; i++) {
        if (ownershipLost) {
          logger.error('backfill', 'Stopping loop due to lost lease', { windowIndex: i });
          loopSuccess = false;
          break;
        }

        const state = await stateRepo.findByKey(providerName, domainName, operationName);
        if (!state || !state.cursor_value) {
          logger.error('backfill', 'No valid cursor found. Bootstrap required.', { stateExists: !!state });
          loopSuccess = false;
          break;
        }

        const cursorObj = JSON.parse(state.cursor_value);
        const lastEndDateStr = cursorObj.lastEndDate;
        if (!lastEndDateStr) {
          logger.error('backfill', 'Corrupted cursor, missing lastEndDate', { cursorObj });
          loopSuccess = false;
          break;
        }

        currentCursor = lastEndDateStr;
        const lastEnd = new Date(lastEndDateStr);
        const today = new Date(clock.now());

        if (lastEnd.getTime() >= today.getTime() || (lastEnd.toISOString().split('T')[0] === today.toISOString().split('T')[0])) {
          logger.info('backfill', `Reached today's date (${lastEndDateStr}). Stopping backfill.`);
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

        const result = await ordersSync.execute(context);

        if (!result.success) {
          logger.error('backfill', 'Window failed during OrdersSync execution', { error: result.error?.message });
          totalErrors++;
          loopSuccess = false;
          break; // Stop immediately on failure
        }

        const stillOwner = await leaseRepo.renew(providerName, domainName, operationName, workerId, policy.lease_ttl_seconds).catch(() => false);
        if (!stillOwner) {
          ownershipLost = true;
          logger.error('backfill', 'Lost lease ownership prior to state advancement', { windowIndex: i });
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
          totalDiscovered += result.metrics.discovered || 0;
          totalHydrated += result.metrics.hydrated || 0;
          totalErrors += result.metrics.errors || 0;
        }
        currentCursor = newCursor;
      }

      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (!ownershipLost) {
        await leaseRepo.release(providerName, domainName, operationName, workerId);
      }

      return { success: loopSuccess, windowsProcessed, finalCursor: currentCursor, totalDiscovered, totalHydrated, totalErrors };
    } catch (err) {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error('backfill', 'Fatal exception caught in orchestrator', { error: errorMessage, stack });
      return { success: false, windowsProcessed, finalCursor: currentCursor, totalDiscovered, totalHydrated, totalErrors };
    }
  }
}
