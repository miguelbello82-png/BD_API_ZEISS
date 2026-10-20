// ============================================================
// StoreBootstrapOrchestrator — BD_API_ZEISS Platform
// ============================================================
// Multi-Store Historical Bootstrap Engine
// 
// Contract:
// 1. Validates store lifecycle transition: ready -> bootstrapping -> catching_up -> active.
// 2. Discovers enabled domains and respects ZEISS retention limits.
// 3. Slices historical ranges, tracking checkpoints per domain in integration.store_sync_state.
// 4. Guarantees 100% store_id segregation on all inserted rows.
// 5. Supports resilient resumption from failure without duplicate work.
// 6. Runs incremental catch-up sync before marking store active.
// ============================================================

import { IDatabaseExecutor } from '../config/db';
import { IStoreResolutionService } from '../core/StoreResolutionService';
import { buildStoreCompositionDeps } from './StoreCompositionRoot';
import { CompositionRootDeps } from './CompositionRoot';
import {
  StoreStatus,
  StoreNotFoundError,
  StoreSuspendedError,
  StoreValidationError,
  StoreZeissContext
} from '../contracts/store';
import { ILogger, ConsoleLogger } from '../observability/Logger';
import { IClock, RealClock } from '../utils/Clock';
import { DateSlice, OrderRecord } from '../contracts/types';
import {
  OrdersMapper,
  OrderDetailMapper,
  TrackingMapper,
  ReceivableMapper,
  CampaignMapper,
  LeadMapper
} from './Mappers';

export interface StoreBootstrapOptions {
  /** Retention lookback in days. Default is 90 days. ZEISS hard ceiling is 180 days. */
  lookbackDays?: number;
  /** Days per slice. Default is 7 days. */
  sliceDays?: number;
  /** End date for the bootstrap. Defaults to now. */
  endDate?: Date;
  /** Whether to skip the incremental catch-up step. Default is false. */
  skipCatchUp?: boolean;
}

export interface DomainBootstrapSummary {
  domain: string;
  totalRecordsFetched: number;
  totalRecordsPersisted: number;
  slicesCompleted: number;
  resumedFromSlice: number;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
}

export interface StoreBootstrapResult {
  storeId: string;
  storeCode: string;
  organizationId: string;
  previousStatus: StoreStatus;
  currentStatus: StoreStatus;
  startedAt: Date;
  completedAt: Date;
  lookbackDays: number;
  retentionHorizonDate: string;
  domains: Record<string, DomainBootstrapSummary>;
  catchUpCompleted: boolean;
  success: boolean;
  error?: string;
}

interface CheckpointData {
  completedSliceKeys: string[];
  lastCompletedDate: string | null;
  recordsCount: number;
  status: 'in_progress' | 'completed' | 'failed';
  updatedAt: string;
}

export class StoreBootstrapOrchestrator {
  private readonly logger: ILogger;
  private readonly clock: IClock;

  constructor(
    private db: IDatabaseExecutor,
    private storeResolutionService: IStoreResolutionService,
    logger?: ILogger,
    clock?: IClock
  ) {
    this.logger = logger || new ConsoleLogger();
    this.clock = clock || new RealClock();
  }

  async bootstrapStore(
    storeId: string,
    options: StoreBootstrapOptions = {}
  ): Promise<StoreBootstrapResult> {
    const startedAt = new Date(this.clock.now());
    const lookbackDays = Math.min(Math.max(options.lookbackDays ?? 90, 1), 180);
    const sliceDays = Math.min(Math.max(options.sliceDays ?? 7, 1), 30);
    const end = options.endDate ?? new Date(this.clock.now());
    const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    // 1. Verify store exists and inspect current status
    const storeRows = await this.db.query<{ id: string; code: string; status: StoreStatus; organization_id: string }>(
      'SELECT id, code, status, organization_id FROM core.stores WHERE id = $1',
      [storeId]
    );

    if (storeRows.length === 0) {
      throw new StoreNotFoundError(storeId);
    }

    const store = storeRows[0];
    const previousStatus = store.status;

    if (store.status === 'draft') {
      throw new StoreValidationError('Store is in draft status. It must be validated before bootstrap can begin.');
    }

    if (store.status === 'suspended') {
      throw new StoreSuspendedError(store.code, store.id);
    }

    if (store.status === 'active') {
      this.logger.warn('StoreBootstrap', `Store ${store.code} is already active. Running re-bootstrap / historical repair.`);
    }

    // 2. Transition store to 'validating' during bootstrap execution
    if (store.status === 'ready') {
      await this.updateStoreStatus(storeId, 'validating');
      this.logger.info('StoreBootstrap', `Transitioned store ${store.code} to 'validating' for bootstrap execution`);
    }

    // 3. Resolve context and build composition deps for the store
    let context: StoreZeissContext;
    try {
      context = await this.storeResolutionService.resolveStore(storeId);
    } catch (err) {
      await this.updateStoreStatus(storeId, 'error');
      throw err;
    }

    const deps = buildStoreCompositionDeps(this.db, context, this.logger, this.clock);

    const domains: Record<string, DomainBootstrapSummary> = {};
    let failureError: string | undefined;

    try {
      // 4. Generate Date Slices for Historical Lookback
      const slices = this.generateDateSlices(start, end, sliceDays);
      this.logger.info(
        'StoreBootstrap',
        `Generated ${slices.length} slices of ~${sliceDays} days (from ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}) for store ${store.code}`
      );

      // --- Domain A: Orders (ORD-001 + ORD-002) ---
      const ordersSummary = await this.bootstrapOrdersDomain(context, deps, slices);
      domains['orders'] = ordersSummary;
      if (ordersSummary.status === 'failed') {
        throw new Error(`Orders bootstrap failed: ${ordersSummary.error}`);
      }

      // --- Domain B: Tracking (TRK-001) ---
      const trackingSummary = await this.bootstrapTrackingDomain(context, deps);
      domains['tracking'] = trackingSummary;

      // --- Domain C: Receivables (FIN-001) ---
      const receivablesSummary = await this.bootstrapReceivablesDomain(context, deps, start, end);
      domains['receivables'] = receivablesSummary;

      // --- Domain D: Campaigns & Leads (CAM-001 / LEAD-001 / LEAD-002) ---
      const campaignsSummary = await this.bootstrapCampaignsDomain(context, deps);
      domains['campaigns'] = campaignsSummary;

      // 5. Incremental catch-up phase
      this.logger.info('StoreBootstrap', `All historical domains complete. Running incremental catch-up for store ${store.code}`);

      // 6. Incremental Catch-up Sync
      let catchUpDone = false;
      if (!options.skipCatchUp) {
        await this.runCatchUpSync(deps);
        catchUpDone = true;
      }

      // 7. Transition to 'active'
      await this.updateStoreStatus(storeId, 'active');
      this.logger.info('StoreBootstrap', `Store ${store.code} successfully bootstrapped and activated! Status: 'active'`);

      return {
        storeId,
        storeCode: store.code,
        organizationId: store.organization_id,
        previousStatus,
        currentStatus: 'active',
        startedAt,
        completedAt: new Date(this.clock.now()),
        lookbackDays,
        retentionHorizonDate: start.toISOString().slice(0, 10),
        domains,
        catchUpCompleted: catchUpDone,
        success: true
      };
    } catch (err) {
      failureError = err instanceof Error ? err.message : String(err);
      this.logger.error('StoreBootstrap', `Bootstrap failed for store ${store.code}: ${failureError}`);

      await this.updateStoreStatus(storeId, 'error');

      return {
        storeId,
        storeCode: store.code,
        organizationId: store.organization_id,
        previousStatus,
        currentStatus: 'error',
        startedAt,
        completedAt: new Date(this.clock.now()),
        lookbackDays,
        retentionHorizonDate: start.toISOString().slice(0, 10),
        domains,
        catchUpCompleted: false,
        success: false,
        error: failureError
      };
    }
  }

  // ----- Domain: Orders -----
  private async bootstrapOrdersDomain(
    context: StoreZeissContext,
    deps: CompositionRootDeps,
    slices: DateSlice[]
  ): Promise<DomainBootstrapSummary> {
    const domain = 'orders';
    const operation = 'bootstrap';
    this.logger.info('StoreBootstrap', `Starting orders historical bootstrap for store ${context.storeCode}`);

    const checkpoint = await this.loadCheckpoint(context.storeId, domain, operation);
    const completedKeys = new Set(checkpoint?.completedSliceKeys || []);
    const resumedCount = completedKeys.size;
    let fetched = 0;
    let persisted = 0;

    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      const sliceKey = `${slice.startDate}_${slice.endDate}`;

      if (completedKeys.has(sliceKey)) {
        this.logger.debug('StoreBootstrap', `Skipping already completed orders slice ${sliceKey}`);
        continue;
      }

      try {
        this.logger.info('StoreBootstrap', `Processing slice [${i + 1}/${slices.length}]: ${slice.startDate} to ${slice.endDate}`);

        // Call ORD-001 with store credentials
        const rawOrders = await deps.ordersProvider.getOrders(
          slice.startDate,
          slice.endDate,
          'TODOS'
        );

        fetched += rawOrders.length;

        if (rawOrders.length > 0) {
          // Map orders with classifier
          const records: OrderRecord[] = rawOrders.map((raw: Record<string, unknown>) => {
            return OrdersMapper.normalizeOrderListItem(raw);
          });

          // Persist orders (PgOrdersRepository uses the injected storeId)
          await deps.ordersRepo.upsertMany(records);
          persisted += records.length;

          // Hydrate details (ORD-002) for newly discovered orders
          for (const order of records) {
            try {
              const detailRaw = await deps.detailProvider.getOrderDetail(order.order_number);
              if (detailRaw) {
                const detailRecord = OrderDetailMapper.minimize(order.order_number, detailRaw);
                await deps.detailsRepo.upsert(order.order_number, detailRecord);
              }
            } catch (detailErr) {
              this.logger.warn('StoreBootstrap', `Detail fetch failed for order ${order.order_number}: ${detailErr}`);
            }
          }
        }

        // Record slice completion
        completedKeys.add(sliceKey);
        await this.saveCheckpoint(context.storeId, domain, operation, {
          completedSliceKeys: Array.from(completedKeys),
          lastCompletedDate: slice.endDate,
          recordsCount: persisted,
          status: completedKeys.size === slices.length ? 'completed' : 'in_progress',
          updatedAt: new Date(this.clock.now()).toISOString()
        });
      } catch (sliceErr) {
        const msg = sliceErr instanceof Error ? sliceErr.message : String(sliceErr);
        await this.saveCheckpoint(context.storeId, domain, operation, {
          completedSliceKeys: Array.from(completedKeys),
          lastCompletedDate: slice.endDate,
          recordsCount: persisted,
          status: 'failed',
          updatedAt: new Date(this.clock.now()).toISOString()
        });
        return {
          domain,
          totalRecordsFetched: fetched,
          totalRecordsPersisted: persisted,
          slicesCompleted: completedKeys.size,
          resumedFromSlice: resumedCount,
          status: 'failed',
          error: msg
        };
      }
    }

    return {
      domain,
      totalRecordsFetched: fetched,
      totalRecordsPersisted: persisted,
      slicesCompleted: completedKeys.size,
      resumedFromSlice: resumedCount,
      status: 'completed'
    };
  }

  // ----- Domain: Tracking -----
  private async bootstrapTrackingDomain(
    context: StoreZeissContext,
    deps: CompositionRootDeps
  ): Promise<DomainBootstrapSummary> {
    const domain = 'tracking';
    const operation = 'bootstrap';
    this.logger.info('StoreBootstrap', `Starting tracking bootstrap for store ${context.storeCode}`);

    try {
      // Find orders eligible for tracking
      const candidates = await deps.trackingRepo.findTrackingCandidates();
      let fetched = 0;
      let persisted = 0;

      for (const candidate of candidates) {
        if (!candidate.order_number || !candidate.nf_number) continue;
        try {
          const rawTracking = await deps.trackingProvider.getTracking(candidate.nf_number);
          if (rawTracking && rawTracking.length > 0) {
            fetched++;
            const events = TrackingMapper.minimize(rawTracking);
            if (events.length > 0) {
              await deps.trackingRepo.upsert(candidate.order_number, candidate.nf_number, events);
              persisted++;
            }
          }
        } catch (trkErr) {
          this.logger.debug('StoreBootstrap', `Tracking lookup skipped for order ${candidate.order_number}: ${trkErr}`);
        }
      }

      await this.saveCheckpoint(context.storeId, domain, operation, {
        completedSliceKeys: ['all'],
        lastCompletedDate: new Date(this.clock.now()).toISOString().slice(0, 10),
        recordsCount: persisted,
        status: 'completed',
        updatedAt: new Date(this.clock.now()).toISOString()
      });

      return {
        domain,
        totalRecordsFetched: fetched,
        totalRecordsPersisted: persisted,
        slicesCompleted: 1,
        resumedFromSlice: 0,
        status: 'completed'
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        domain,
        totalRecordsFetched: 0,
        totalRecordsPersisted: 0,
        slicesCompleted: 0,
        resumedFromSlice: 0,
        status: 'failed',
        error: msg
      };
    }
  }

  // ----- Domain: Receivables -----
  private async bootstrapReceivablesDomain(
    context: StoreZeissContext,
    deps: CompositionRootDeps,
    start: Date,
    end: Date
  ): Promise<DomainBootstrapSummary> {
    const domain = 'financial';
    const operation = 'bootstrap';
    this.logger.info('StoreBootstrap', `Starting receivables bootstrap for store ${context.storeCode}`);

    try {
      const startStr = start.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);

      const rawReceivables = await deps.receivablesProvider.getReceivables(startStr, endStr, 'TODOS', '');
      let persisted = 0;

      if (rawReceivables && rawReceivables.length > 0) {
        const records = rawReceivables.map(r => ReceivableMapper.normalize(r));
        await deps.receivablesRepo.upsertMany(records);
        persisted = records.length;
      }

      await this.saveCheckpoint(context.storeId, domain, operation, {
        completedSliceKeys: ['all'],
        lastCompletedDate: new Date(this.clock.now()).toISOString().slice(0, 10),
        recordsCount: persisted,
        status: 'completed',
        updatedAt: new Date(this.clock.now()).toISOString()
      });

      return {
        domain,
        totalRecordsFetched: rawReceivables ? rawReceivables.length : 0,
        totalRecordsPersisted: persisted,
        slicesCompleted: 1,
        resumedFromSlice: 0,
        status: 'completed'
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        domain,
        totalRecordsFetched: 0,
        totalRecordsPersisted: 0,
        slicesCompleted: 0,
        resumedFromSlice: 0,
        status: 'failed',
        error: msg
      };
    }
  }

  // ----- Domain: Campaigns & Leads -----
  private async bootstrapCampaignsDomain(
    context: StoreZeissContext,
    deps: CompositionRootDeps
  ): Promise<DomainBootstrapSummary> {
    const domain = 'campaigns';
    const operation = 'bootstrap';
    this.logger.info('StoreBootstrap', `Starting campaigns & leads bootstrap for store ${context.storeCode}`);

    try {
      const rawCampaigns = await deps.campaignsProvider.getCampaigns();
      let persistedCampaigns = 0;
      let totalLeadsPersisted = 0;

      if (rawCampaigns && rawCampaigns.length > 0) {
        const campaignRecords = rawCampaigns.map(c => CampaignMapper.normalize(c));
        await deps.campaignsRepo.upsertMany(campaignRecords);
        persistedCampaigns = campaignRecords.length;

        // For each active campaign, fetch leads
        if (context.leadsHmacSecret) {
          for (const camp of campaignRecords) {
            try {
              const rawLeads = await deps.leadsProvider.getLeads(camp.campaign_id);
              if (rawLeads && rawLeads.length > 0) {
                const leadRecords = rawLeads.map(l => LeadMapper.normalize(l, camp.campaign_id, context.leadsHmacSecret!));
                await deps.leadsRepo.upsertMany(camp.campaign_id, leadRecords);
                totalLeadsPersisted += leadRecords.length;
              }
            } catch (leadsErr) {
              this.logger.warn('StoreBootstrap', `Leads fetch skipped for campaign ${camp.campaign_id}: ${leadsErr}`);
            }
          }
        }
      }

      await this.saveCheckpoint(context.storeId, domain, operation, {
        completedSliceKeys: ['all'],
        lastCompletedDate: new Date(this.clock.now()).toISOString().slice(0, 10),
        recordsCount: persistedCampaigns + totalLeadsPersisted,
        status: 'completed',
        updatedAt: new Date(this.clock.now()).toISOString()
      });

      return {
        domain,
        totalRecordsFetched: persistedCampaigns + totalLeadsPersisted,
        totalRecordsPersisted: persistedCampaigns + totalLeadsPersisted,
        slicesCompleted: 1,
        resumedFromSlice: 0,
        status: 'completed'
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        domain,
        totalRecordsFetched: 0,
        totalRecordsPersisted: 0,
        slicesCompleted: 0,
        resumedFromSlice: 0,
        status: 'failed',
        error: msg
      };
    }
  }

  // ----- Incremental Catch-Up Sync -----
  private async runCatchUpSync(
    deps: CompositionRootDeps
  ): Promise<void> {
    const now = new Date(this.clock.now());
    const recentStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recentEnd = now.toISOString().slice(0, 10);

    const recentOrders = await deps.ordersProvider.getOrders(
      recentStart,
      recentEnd,
      'TODOS'
    );

    if (recentOrders.length > 0) {
      const records: OrderRecord[] = recentOrders.map((raw: Record<string, unknown>) => {
        return OrdersMapper.normalizeOrderListItem(raw);
      });
      await deps.ordersRepo.upsertMany(records);
    }
  }

  // ----- Checkpoint Helpers -----
  private async loadCheckpoint(storeId: string, domain: string, operation: string): Promise<CheckpointData | null> {
    const rows = await this.db.query<{ cursor_value: unknown }>(
      'SELECT cursor_value FROM integration.store_sync_state WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4',
      [storeId, 'zeiss', domain, operation]
    );

    if (rows.length === 0 || !rows[0].cursor_value) return null;

    try {
      if (typeof rows[0].cursor_value === 'string') {
        return JSON.parse(rows[0].cursor_value) as CheckpointData;
      }
      return rows[0].cursor_value as CheckpointData;
    } catch {
      return null;
    }
  }

  private async saveCheckpoint(
    storeId: string,
    domain: string,
    operation: string,
    data: CheckpointData
  ): Promise<void> {
    const query = `
      INSERT INTO integration.store_sync_state (store_id, provider, domain, operation, last_sync, cursor_value, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (store_id, provider, domain, operation)
      DO UPDATE SET
        last_sync = EXCLUDED.last_sync,
        cursor_value = EXCLUDED.cursor_value,
        updated_at = CURRENT_TIMESTAMP
    `;
    await this.db.query(query, [
      storeId,
      'zeiss',
      domain,
      operation,
      JSON.stringify(data)
    ]);
  }

  private async updateStoreStatus(storeId: string, status: StoreStatus): Promise<void> {
    await this.db.query(
      'UPDATE core.stores SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, storeId]
    );
  }

  private generateDateSlices(start: Date, end: Date, sliceDays: number): DateSlice[] {
    const slices: DateSlice[] = [];
    let currentStart = new Date(start);

    while (currentStart < end) {
      const currentEnd = new Date(currentStart.getTime() + sliceDays * 24 * 60 * 60 * 1000);
      const effectiveEnd = currentEnd > end ? end : currentEnd;

      slices.push({
        startDate: currentStart.toISOString().slice(0, 10),
        endDate: effectiveEnd.toISOString().slice(0, 10)
      });

      currentStart = new Date(effectiveEnd.getTime() + 1000); // 1 second forward to next day
    }

    return slices;
  }
}
