// ============================================================
// OrdersSync — BD_API_ZEISS Platform
// ============================================================
// State-driven orders synchronization engine.
//
// Principles:
// - Discovery via ORD-001 (incremental, date-bounded).
// - Hydration via ORD-002 is state-driven, not age-driven.
// - No fixed-day window as principal mechanism.
// - Restart-safe: pending work is reconstructed from the database.
// - No hardcoded ZEISS status values.
// ============================================================

import {
  IOrdersRepository,
  IOrderDetailsRepository,
} from '../contracts/repositories';
import {
  IOrdersListProvider,
  IOrderDetailProvider,
} from '../contracts/providers';
import { IOrderClassifier, OrderLifecycleStage } from './Classifiers';
import { ILogger } from '../observability/Logger';
import { OrdersMapper, OrderDetailMapper } from './Mappers';
import { DateSlice, OrderStateInput, OrderCandidate } from '../contracts/types';
import { OrdersDiscoveryPlanner } from './OrdersDiscoveryPlanner';
import { IJob, JobContext, JobResult } from './JobRegistry';

import { IClock } from '../utils/Clock';

export interface OrdersSyncDeps {
  ordersProvider: IOrdersListProvider;
  detailProvider: IOrderDetailProvider;
  ordersRepo: IOrdersRepository;
  detailsRepo: IOrderDetailsRepository;
  classifier: IOrderClassifier;
  logger: ILogger;
  clock: IClock;
}

export class OrdersSync implements IJob {
  private readonly deps: OrdersSyncDeps;
  private static readonly COMPONENT = 'OrdersSync';

  constructor(deps: OrdersSyncDeps) {
    this.deps = deps;
  }

  async execute(context: JobContext): Promise<JobResult> {
    const { abortSignal, lastSyncState, policy } = context;

    this.deps.logger.info(OrdersSync.COMPONENT, 'Starting orders discovery job');
    
    let lastEndDate: string | undefined;
    if (lastSyncState && lastSyncState.cursor_value) {
      try {
        const cursorObj = JSON.parse(lastSyncState.cursor_value);
        if (cursorObj && typeof cursorObj === 'object' && cursorObj.lastEndDate) {
          lastEndDate = cursorObj.lastEndDate;
        }
      } catch (e) {
        // invalid cursor, will fall into bootstrap failure
      }
    }

    // Fail fast if there is no valid operation config for discovery range limit
    // We assume `policy.operation_config` should have `maxRangeDays`.
    const config = policy.operation_config as Record<string, unknown> || {};
    if (!config.maxRangeDays) {
      throw new Error('CONFIGURATION_ERROR: maxRangeDays is required for continuous orders discovery.');
    }

    const slice = OrdersDiscoveryPlanner.planNextSlice(
      lastEndDate, 
      { maxRangeDays: config.maxRangeDays as number }, 
      this.deps.clock.now()
    );

    // Filter status must come from config
    if (typeof config.statusFilter !== 'string') {
      throw new Error('CONFIGURATION_ERROR: statusFilter is required for ORD-001.');
    }
    const statusFilter = config.statusFilter;

    let rawOrders: Record<string, unknown>[];
    try {
      rawOrders = await this.deps.ordersProvider.getOrders(
        slice.startDate,
        slice.endDate,
        statusFilter, // Passed without hardcoding 'TODOS'
        abortSignal
      );
    } catch (err) {
      if (abortSignal.aborted) {
        return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
      }
      return { success: false, retryable: true, error: err instanceof Error ? err : new Error(String(err)) };
    }

    if (abortSignal.aborted) {
      return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
    }

    let hydratedCount = 0;
    let errors = 0;

    try {
      const orderRecords = rawOrders.map(OrdersMapper.normalizeOrderListItem);
      await this.deps.ordersRepo.upsertMany(orderRecords);

      const missingDetail = await this.deps.ordersRepo.findOrdersWithoutDetail();
      const hydratedIds = new Set<string>();

      for (const candidate of missingDetail) {
        if (abortSignal.aborted) break;

        const stateInput: OrderStateInput = { status: candidate.raw_status, codsit: candidate.raw_codsit };
        if (this.deps.classifier.isCancelled(stateInput)) {
          this.deps.logger.info(OrdersSync.COMPONENT, 'Skipping hydration for cancelled order', { orderNumber: candidate.order_number });
          continue;
        }

        const ok = await this.hydrateOrder(candidate.order_number, abortSignal);
        if (ok) {
          hydratedCount++;
          hydratedIds.add(candidate.order_id);
        } else {
          errors++;
        }
      }

      if (!abortSignal.aborted) {
        const candidates = await this.deps.ordersRepo.findActiveOrders();
        for (const candidate of candidates) {
          if (abortSignal.aborted) break;

          const stateInput: OrderStateInput = { status: candidate.raw_status, codsit: candidate.raw_codsit };
          if (!this.deps.classifier.isMutable(stateInput)) {
            continue;
          }
          
          if (!hydratedIds.has(candidate.order_id)) {
            const ok = await this.hydrateOrder(candidate.order_number, abortSignal);
            if (ok) hydratedCount++;
            else errors++;
          }
        }
      }
    } catch (err) {
      return { success: false, retryable: true, error: err instanceof Error ? err : new Error(String(err)) };
    }

    if (abortSignal.aborted) {
      return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
    }

    return {
      success: true, // ORD-001 discovery success is independent from ORD-002 hydration failures
      retryable: true, 
      cursorValue: JSON.stringify({ lastEndDate: slice.endDate }),
      metrics: {
        discovered: rawOrders.length,
        hydrated: hydratedCount,
        hydration_errors: errors
      }
    };
  }

  async hydrateOrder(orderNumber: string, abortSignal?: AbortSignal): Promise<boolean> {
    try {
      const rawDetail = await this.deps.detailProvider.getOrderDetail(orderNumber, abortSignal);
      const detail = OrderDetailMapper.minimize(orderNumber, rawDetail);
      await this.deps.detailsRepo.upsert(orderNumber, detail);
      this.deps.logger.info(OrdersSync.COMPONENT, 'Order hydrated', { orderNumber });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.error(OrdersSync.COMPONENT, 'Hydration failed', {
        orderNumber,
        error: message,
      });
      return false;
    }
  }

  classifyOrder(state: OrderStateInput): OrderLifecycleStage {
    return this.deps.classifier.classify(state);
  }
}
