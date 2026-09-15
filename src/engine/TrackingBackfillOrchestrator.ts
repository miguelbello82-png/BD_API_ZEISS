import { ITrackingProvider } from '../contracts/providers';
import { ITrackingRepository, ISyncPolicyRepository, ISyncStateRepository, ISyncLeaseRepository } from '../contracts/repositories';
import { IOrderClassifier, ITrackingClassifier } from './Classifiers';
import { ILogger } from '../observability/Logger';
import { TrackingSync } from './TrackingSync';
import { JobContext } from './JobRegistry';

export interface TrackingBackfillOrchestratorDeps {
  trackingProvider: ITrackingProvider;
  trackingRepo: ITrackingRepository;
  policyRepo: ISyncPolicyRepository;
  stateRepo: ISyncStateRepository;
  leaseRepo: ISyncLeaseRepository;
  orderClassifier: IOrderClassifier;
  trackingClassifier: ITrackingClassifier;
  logger: ILogger;
  workerId: string;
}

export class TrackingBackfillOrchestrator {
  constructor(private deps: TrackingBackfillOrchestratorDeps) {}

  async run(maxBatches: number = 1000): Promise<{ 
    success: boolean; 
    batchesProcessed: number; 
    candidatesFound: number;
    updated: number;
    not_found: number;
    fetch_errors: number;
    startingCursor: string; 
    endingCursor: string; 
    reachedEndOfCandidateSet: boolean;
  }> {
    const { logger, workerId, policyRepo, leaseRepo, stateRepo, trackingProvider, trackingRepo, orderClassifier, trackingClassifier } = this.deps;
    const providerName = 'zeiss';
    const domainName = 'tracking';
    const operationName = 'sync';

    let batchesProcessed = 0;
    let candidatesFound = 0;
    let updated = 0;
    let not_found = 0;
    let fetch_errors = 0;
    let startingCursor = '';
    let endingCursor = '';
    let reachedEndOfCandidateSet = false;
    
    let keepaliveTimer: NodeJS.Timeout | null = null;
    let ownershipLost = false;

    try {
      const policy = await policyRepo.findByKey(providerName, domainName, operationName);
      if (!policy || !policy.enabled) {
        logger.error('backfill-tracking', 'Tracking sync policy is not enabled or not found', { policyEnabled: policy?.enabled });
        return { success: false, batchesProcessed, candidatesFound, updated, not_found, fetch_errors, startingCursor, endingCursor, reachedEndOfCandidateSet };
      }

      const acquisition = await leaseRepo.tryAcquire(providerName, domainName, operationName, workerId, policy.lease_ttl_seconds);
      if (!acquisition.acquired) {
        logger.error('backfill-tracking', 'Could not acquire lease', { acquisition });
        return { success: false, batchesProcessed, candidatesFound, updated, not_found, fetch_errors, startingCursor, endingCursor, reachedEndOfCandidateSet };
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

      const trackingSyncJob = new TrackingSync({
        trackingProvider,
        trackingRepo,
        orderClassifier,
        trackingClassifier,
        logger
      });

      const initialState = await stateRepo.findByKey(providerName, domainName, operationName);
      startingCursor = initialState?.cursor_value || '';
      endingCursor = startingCursor;

      let loopSuccess = true;
      for (let i = 0; i < maxBatches; i++) {
        if (ownershipLost) {
          logger.error('backfill-tracking', 'Stopping loop due to lost lease', { batchIndex: i });
          loopSuccess = false;
          break;
        }

        const state = await stateRepo.findByKey(providerName, domainName, operationName);

        const controller = new AbortController();
        const context: JobContext = {
          provider: providerName,
          domain: domainName,
          operation: operationName,
          abortSignal: controller.signal,
          lastSyncState: state,
          policy,
        };

        const result = await trackingSyncJob.execute(context);

        if (!result.success) {
          logger.error('backfill-tracking', 'Batch failed during TrackingSync execution', { error: result.error?.message });
          if (result.metrics) {
            candidatesFound += result.metrics.candidatesFound || 0;
            updated += result.metrics.updated || 0;
            not_found += result.metrics.not_found || 0;
            fetch_errors += result.metrics.fetch_errors || 0;
          }
          loopSuccess = false;
          break; // Stop immediately on failure
        }

        const stillOwner = await leaseRepo.renew(providerName, domainName, operationName, workerId, policy.lease_ttl_seconds).catch(() => false);
        if (!stillOwner) {
          ownershipLost = true;
          logger.error('backfill-tracking', 'Lost lease ownership prior to state advancement', { batchIndex: i });
          loopSuccess = false;
          break;
        }

        const newCursor = result.cursorValue || '';
        if (newCursor) {
          await stateRepo.upsert({
            provider: providerName,
            domain: domainName,
            operation: operationName,
            last_sync: new Date(),
            cursor_value: newCursor
          });
        }

        batchesProcessed++;
        if (result.metrics) {
          candidatesFound += result.metrics.candidatesFound || 0;
          updated += result.metrics.updated || 0;
          not_found += result.metrics.not_found || 0;
          fetch_errors += result.metrics.fetch_errors || 0;
        }
        endingCursor = newCursor;

        let parsedCursor: any = {};
        try {
          parsedCursor = JSON.parse(newCursor);
        } catch(e) {}
        
        if (!parsedCursor.lastOrderId) {
          logger.info('backfill-tracking', 'Reached the end of tracking candidates. Traversal complete.');
          reachedEndOfCandidateSet = true;
          break; // Do not start a second pass
        }
      }

      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (!ownershipLost) {
        await leaseRepo.release(providerName, domainName, operationName, workerId);
      }

      return {
        success: loopSuccess,
        batchesProcessed,
        candidatesFound,
        updated,
        not_found,
        fetch_errors,
        startingCursor,
        endingCursor,
        reachedEndOfCandidateSet
      };

    } catch (error) {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (!ownershipLost) {
        await leaseRepo.release(providerName, domainName, operationName, workerId).catch(() => {});
      }
      logger.error('backfill-tracking', 'Unexpected error in tracking backfill', { error: error instanceof Error ? error.message : String(error) });
      return { success: false, batchesProcessed, candidatesFound, updated, not_found, fetch_errors, startingCursor, endingCursor, reachedEndOfCandidateSet };
    }
  }
}
