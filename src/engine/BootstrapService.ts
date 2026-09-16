// ============================================================
// BootstrapService — BD_API_ZEISS Platform
// ============================================================
// Parametric historic data bootstrap for Orders and Tracking.
//
// Orders bootstrap:
// - Accepts arbitrary date range (no fixed 10-slice limit).
// - Processes in configurable slices.
// - Idempotent, retomable, database-driven progress.
//
// Tracking bootstrap:
// - 2026 has priority.
// - Pre-2026 accepts configurable slicing (up to 10 intervals
//   as an operational parameter, not a domain constant).
// ============================================================

import {
  IOrdersRepository,
  IOrderDetailsRepository,
  ITrackingRepository,
  ISyncStateRepository,
  IProviderHealthRepository,
} from '../contracts/repositories';
import { IOrdersListProvider, IOrderDetailProvider, ITrackingProvider } from '../contracts/providers';
import { IOrderClassifier, ITrackingClassifier } from './Classifiers';
import { ILogger } from '../observability/Logger';
import { OrdersMapper, OrderDetailMapper, TrackingMapper } from './Mappers';
import { DateSlice, OrderStateInput, OrderCandidate, TrackingCandidate } from '../contracts/types';

// ----- Configuration Types -----

export interface OrdersBootstrapConfig {
  /** Date slices to process. Each slice is a (startDate, endDate) pair. */
  slices: DateSlice[];
  /** Status filter for ORD-001 (e.g. "TODOS"). */
  status: string;
}

export interface TrackingBootstrapConfig {
  /**
   * Priority: 2026 slices are processed first.
   * Pre-2026 slices are processed after.
   * The operational limit of up to 10 pre-2026 slices is enforced
   * by the caller, not by this service.
   */
  prioritySlices: DateSlice[];
  historicSlices: DateSlice[];
}

// ----- Results -----

export interface BootstrapSliceResult {
  slice: DateSlice;
  ordersDiscovered: number;
  ordersHydrated: number;
  errors: string[];
}

export interface OrdersBootstrapResult {
  totalDiscovered: number;
  totalHydrated: number;
  sliceResults: BootstrapSliceResult[];
  errors: string[];
}

export interface TrackingBootstrapResult {
  totalCandidates: number;
  totalUpdated: number;
  errors: string[];
}

// ----- Service -----

export interface BootstrapDeps {
  ordersProvider: IOrdersListProvider;
  detailProvider: IOrderDetailProvider;
  trackingProvider: ITrackingProvider;
  ordersRepo: IOrdersRepository;
  detailsRepo: IOrderDetailsRepository;
  trackingRepo: ITrackingRepository;
  syncStateRepo: ISyncStateRepository;
  orderClassifier: IOrderClassifier;
  trackingClassifier: ITrackingClassifier;
  logger: ILogger;
}

export class BootstrapService {
  private readonly deps: BootstrapDeps;
  private static readonly COMPONENT = 'BootstrapService';

  constructor(deps: BootstrapDeps) {
    this.deps = deps;
  }

  /**
   * Bootstrap orders for a set of date slices.
   * Each slice runs ORD-001 → UPSERT → ORD-002 for all found orders.
   * Progress is recorded per slice for retomability.
   */
  async bootstrapOrders(config: OrdersBootstrapConfig): Promise<OrdersBootstrapResult> {
    const result: OrdersBootstrapResult = {
      totalDiscovered: 0,
      totalHydrated: 0,
      sliceResults: [],
      errors: [],
    };

    this.deps.logger.info(BootstrapService.COMPONENT, 'Starting orders bootstrap', {
      totalSlices: config.slices.length,
    });

    let slicesToProcess = config.slices;

    // Real resume: Read sync state before loop
    const syncState = await this.deps.syncStateRepo.findByKey('zeiss', 'orders', 'bootstrap');
    if (syncState && syncState.cursor_value) {
      try {
        const cursor = JSON.parse(syncState.cursor_value);
        if (cursor && cursor.lastSlice) {
          const lastSlice = cursor.lastSlice as DateSlice;
          const index = slicesToProcess.findIndex(
            s => s.startDate === lastSlice.startDate && s.endDate === lastSlice.endDate
          );
          if (index >= 0) {
            this.deps.logger.info(BootstrapService.COMPONENT, 'Resuming after completed slice', { lastSlice });
            slicesToProcess = slicesToProcess.slice(index + 1);
          } else {
            throw new Error('Cursor points to an unknown slice not present in config');
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Invalid or missing cursor state: ${msg}`);
        return result; // Stop immediately if cursor is corrupted
      }
    }

    for (const slice of slicesToProcess) {
      const sliceResult = await this.processOrderSlice(slice, config.status);
      result.sliceResults.push(sliceResult);
      result.totalDiscovered += sliceResult.ordersDiscovered;
      result.totalHydrated += sliceResult.ordersHydrated;
      result.errors.push(...sliceResult.errors);

      if (sliceResult.errors.length > 0) {
        this.deps.logger.warn(BootstrapService.COMPONENT, 'Slice had partial failures. Stopping bootstrap.', { slice });
        break; // Stop on first failure. Do NOT advance cursor. Next run will retry this slice.
      }

      // Record progress for retomability
      await this.deps.syncStateRepo.upsert({
        provider: 'zeiss',
        domain: 'orders',
        operation: 'bootstrap',
        last_sync: new Date(),
        cursor_value: JSON.stringify({ lastSlice: slice }),
      });
    }

    this.deps.logger.info(BootstrapService.COMPONENT, 'Orders bootstrap stopped or completed', {
      totalDiscovered: result.totalDiscovered,
      totalHydrated: result.totalHydrated,
      errors: result.errors.length,
    });

    return result;
  }

  private async processOrderSlice(
    slice: DateSlice,
    status: string,
  ): Promise<BootstrapSliceResult> {
    const sliceResult: BootstrapSliceResult = {
      slice,
      ordersDiscovered: 0,
      ordersHydrated: 0,
      errors: [],
    };

    this.deps.logger.info(BootstrapService.COMPONENT, 'Processing order slice', {
      start: slice.startDate,
      end: slice.endDate,
    });

    // Discovery
    let rawOrders: Record<string, unknown>[];
    try {
      rawOrders = await this.deps.ordersProvider.getOrders(
        slice.startDate,
        slice.endDate,
        status,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sliceResult.errors.push(`Discovery failed for slice: ${message}`);
      return sliceResult;
    }

    // Map and UPSERT all orders
    const records = [];
    for (const raw of rawOrders) {
      try {
         records.push(OrdersMapper.normalizeOrderListItem(raw));
      } catch (err) {
         const message = err instanceof Error ? err.message : String(err);
         sliceResult.errors.push(`Mapping failed for order: ${message}`);
      }
    }
    
    sliceResult.ordersDiscovered = records.length;
    
    if (records.length > 0) {
       await this.deps.ordersRepo.upsertMany(records);
    }

    // Hydrate orders in bootstrap (complete snapshot)
    // Cancelled orders are only hydrated if they don't have details yet.
    for (const rec of records) {
      const stateInput: OrderStateInput = { status: rec.status, codsit: rec.codsit };
      
      if (this.deps.orderClassifier.isCancelled(stateInput)) {
        const hasDetail = await this.deps.detailsRepo.exists(rec.order_number);
        if (hasDetail) {
          continue;
        }
      }

      try {
        const rawDetail = await this.deps.detailProvider.getOrderDetail(rec.order_number);
        const detail = OrderDetailMapper.minimize(rec.order_number, rawDetail);
        await this.deps.detailsRepo.upsert(rec.order_number, detail);
        sliceResult.ordersHydrated++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sliceResult.errors.push(`Hydration failed for ${rec.order_number}: ${message}`);
      }
    }

    return sliceResult;
  }

  /**
   * Bootstrap tracking for eligible orders.
   * Priority slices (2026) are processed first, then historic slices.
   */
  async bootstrapTracking(config: TrackingBootstrapConfig): Promise<TrackingBootstrapResult> {
    const result: TrackingBootstrapResult = {
      totalCandidates: 0,
      totalUpdated: 0,
      errors: [],
    };

    this.deps.logger.info(BootstrapService.COMPONENT, 'Starting tracking bootstrap', {
      prioritySlices: config.prioritySlices.length,
      historicSlices: config.historicSlices.length,
    });

    const allSlices = [...config.prioritySlices, ...config.historicSlices];
    let slicesToProcess = allSlices;

    const syncState = await this.deps.syncStateRepo.findByKey('zeiss', 'tracking', 'bootstrap');
    if (syncState && syncState.cursor_value) {
      try {
        const cursor = JSON.parse(syncState.cursor_value);
        if (cursor && cursor.lastProcessedSlice) {
          const lastSlice = cursor.lastProcessedSlice as DateSlice;
          const index = slicesToProcess.findIndex(
            s => s.startDate === lastSlice.startDate && s.endDate === lastSlice.endDate
          );
          if (index >= 0) {
            this.deps.logger.info(BootstrapService.COMPONENT, 'Resuming after completed slice', { lastSlice });
            slicesToProcess = slicesToProcess.slice(index + 1);
          } else {
            throw new Error('Cursor points to an unknown slice not present in config');
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Invalid or missing cursor state: ${msg}`);
        return result; // Stop immediately if cursor is corrupted
      }
    }

    for (const slice of slicesToProcess) {
      this.deps.logger.info(BootstrapService.COMPONENT, 'Processing tracking slice', {
        start: slice.startDate,
        end: slice.endDate,
      });

      let candidates;
      try {
        candidates = await this.deps.trackingRepo.findTrackingCandidatesByDate(slice.startDate, slice.endDate);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to find tracking candidates for slice: ${msg}`);
        break; // Stop on first slice failure
      }

      this.deps.logger.info(BootstrapService.COMPONENT, `Found ${candidates.length} tracking candidates in slice`);

      let sliceHasErrors = false;

      for (const candidate of candidates) {
        if (!candidate.nf_number || candidate.nf_number.trim() === '') {
          continue;
        }

        const stateInput: OrderStateInput = { 
          status: candidate.raw_order_status, 
          codsit: candidate.raw_order_codsit 
        };

        if (!this.deps.orderClassifier.isBilledLogisticsReady(stateInput)) {
          continue;
        }

        if (this.deps.orderClassifier.isCancelled(stateInput)) {
          continue;
        }

        if (this.deps.trackingClassifier.isTerminal(candidate.tracking_state)) {
          continue;
        }

        try {
          const rawTrackingData = await this.deps.trackingProvider.getTracking(candidate.nf_number);
          const trackingData = TrackingMapper.minimize(rawTrackingData);
          await this.deps.trackingRepo.upsert(
            candidate.order_number,
            candidate.nf_number,
            trackingData,
          );
          result.totalUpdated++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`Tracking bootstrap failed for ${candidate.order_number}: ${message}`);
          sliceHasErrors = true;
        }
      }

      result.totalCandidates += candidates.length;

      if (sliceHasErrors) {
        this.deps.logger.warn(BootstrapService.COMPONENT, 'Tracking slice had partial failures. Stopping bootstrap.', { slice });
        break; // Stop on first failure. Do NOT advance cursor. Next run will retry this slice.
      }

      // Record progress per slice for retomability
      await this.deps.syncStateRepo.upsert({
        provider: 'zeiss',
        domain: 'tracking',
        operation: 'bootstrap',
        last_sync: new Date(),
        cursor_value: JSON.stringify({ lastProcessedSlice: slice }),
      });
    }

    this.deps.logger.info(BootstrapService.COMPONENT, 'Tracking bootstrap stopped or complete', {
      candidates: result.totalCandidates,
      updated: result.totalUpdated,
      errors: result.errors.length,
    });

    return result;
  }

  /**
   * Utility: generate deterministic date slices for a period.
   * Used by callers to construct bootstrap configs.
   */
  static generateSlices(startDate: string, endDate: string, numberOfSlices: number): DateSlice[] {
    if (numberOfSlices <= 0) {
      throw new Error('numberOfSlices must be greater than 0');
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid date format');
    }

    if (start > end) {
      throw new Error('startDate must be before or equal to endDate');
    }

    // Generating slices avoiding overlapping days.
    const totalMs = end.getTime() - start.getTime();
    const totalDays = Math.floor(totalMs / (1000 * 60 * 60 * 24)) + 1;
    
    if (numberOfSlices > totalDays) {
      numberOfSlices = totalDays; // Prevent empty or 0-day slices
    }

    const daysPerSlice = Math.floor(totalDays / numberOfSlices);
    let remainderDays = totalDays % numberOfSlices;
    
    const slices: DateSlice[] = [];
    let currentStart = start;

    for (let i = 0; i < numberOfSlices; i++) {
      let sliceLength = daysPerSlice;
      if (remainderDays > 0) {
        sliceLength++;
        remainderDays--;
      }
      
      const sliceEnd = new Date(currentStart);
      sliceEnd.setDate(currentStart.getDate() + sliceLength - 1);

      slices.push({
        startDate: currentStart.toISOString().split('T')[0],
        endDate: sliceEnd.toISOString().split('T')[0],
      });

      currentStart = new Date(sliceEnd);
      currentStart.setDate(sliceEnd.getDate() + 1);
    }

    return slices;
  }
}
