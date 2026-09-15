// ============================================================
// TrackingSync — BD_API_ZEISS Platform
// ============================================================
// State-driven tracking synchronization.
//
// Principles:
// - Only processes orders classified as BILLED_LOGISTICS_READY.
// - Only calls TRK-001 when contractual identifiers (nf_number) exist.
// - Never invents terminal tracking statuses.
// - TRACKING_TERMINAL_STATUS = UNRESOLVED
// ============================================================

import {
  ITrackingRepository,
} from '../contracts/repositories';
import { TrackingCandidate, OrderStateInput } from '../contracts/types';
import { ITrackingProvider } from '../contracts/providers';
import { IOrderClassifier, ITrackingClassifier } from './Classifiers';
import { TrackingMapper } from './Mappers';
import { ILogger } from '../observability/Logger';
import { IJob, JobContext, JobResult } from './JobRegistry';

export interface TrackingSyncDeps {
  trackingProvider: ITrackingProvider;
  trackingRepo: ITrackingRepository;
  orderClassifier: IOrderClassifier;
  trackingClassifier: ITrackingClassifier;
  logger: ILogger;
}

export class TrackingSync implements IJob {
  private readonly deps: TrackingSyncDeps;
  private static readonly COMPONENT = 'TrackingSync';

  constructor(deps: TrackingSyncDeps) {
    this.deps = deps;
  }

  async execute(context: JobContext): Promise<JobResult> {
    const { abortSignal, lastSyncState, policy } = context;
    
    let candidatesFound = 0;
    let updated = 0;
    let not_found = 0;
    let fetch_errors = 0;

    this.deps.logger.info(TrackingSync.COMPONENT, 'Starting tracking sync cycle');

    const config = policy.operation_config as Record<string, unknown> || {};
    if (typeof config.batch_limit !== 'number' || config.batch_limit <= 0) {
      throw new Error('CONFIGURATION_ERROR: Tracking requires explicit batch_limit in policy config.');
    }
    const limit = config.batch_limit;

    let lastOrderId: string | undefined;
    let lastNfNumber: string | undefined;
    if (lastSyncState && lastSyncState.cursor_value) {
      try {
        const cursorObj = JSON.parse(lastSyncState.cursor_value);
        if (cursorObj && typeof cursorObj === 'object') {
          lastOrderId = typeof cursorObj.lastOrderId === 'string' ? cursorObj.lastOrderId : undefined;
          lastNfNumber = typeof cursorObj.lastNfNumber === 'string' ? cursorObj.lastNfNumber : undefined;
        }
      } catch (e) {}
    }

    let candidates: TrackingCandidate[];
    try {
      const allCandidates = await this.deps.trackingRepo.findTrackingCandidates(lastOrderId, lastNfNumber, limit);
      
      if (allCandidates.length > 0) {
        lastOrderId = allCandidates[allCandidates.length - 1].order_id;
        lastNfNumber = allCandidates[allCandidates.length - 1].nf_number;
      } else {
        lastOrderId = undefined;
        lastNfNumber = undefined;
      }
      
      candidates = allCandidates.filter(c => {
        const stateInput: OrderStateInput = { status: c.raw_order_status, codsit: c.raw_order_codsit };
        return this.deps.orderClassifier.isBilledLogisticsReady(stateInput) &&
               !this.deps.orderClassifier.isCancelled(stateInput) &&
               !this.deps.trackingClassifier.isTerminal(c.tracking_state);
      });
    } catch (err) {
      if (abortSignal.aborted) {
        return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
      }
      return { success: false, retryable: true, error: err instanceof Error ? err : new Error(String(err)) };
    }

    candidatesFound = candidates.length;
    this.deps.logger.info(TrackingSync.COMPONENT, `Found ${candidates.length} tracking candidates`);

    for (const candidate of candidates) {
      if (abortSignal.aborted) break;

      try {
        const rawTrackingData = await this.deps.trackingProvider.getTracking(candidate.nf_number, abortSignal);
        const trackingData = TrackingMapper.minimize(rawTrackingData);
        await this.deps.trackingRepo.upsert(
          candidate.order_number,
          candidate.nf_number,
          trackingData,
        );
        updated++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        
        if (message.includes('404')) {
          not_found++;
          this.deps.logger.info(TrackingSync.COMPONENT, 'Tracking not found (404)', {
            orderNumber: candidate.order_number,
          });
        } else {
          fetch_errors++;
          this.deps.logger.error(TrackingSync.COMPONENT, 'Tracking fetch failed', {
            orderNumber: candidate.order_number,
            error: message,
          });
        }
      }
    }

    if (abortSignal.aborted) {
      return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
    }

    return {
      success: true, // Candidate-level failures do not block cursor advancement
      retryable: true,
      cursorValue: JSON.stringify({ lastOrderId, lastNfNumber }),
      metrics: {
        candidatesFound,
        updated,
        not_found,
        fetch_errors
      }
    };
  }
}
