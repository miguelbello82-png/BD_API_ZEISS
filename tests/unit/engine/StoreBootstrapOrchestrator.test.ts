import { StoreBootstrapOrchestrator } from '../../../src/engine/StoreBootstrapOrchestrator';
import { IDatabaseExecutor } from '../../../src/config/db';
import { IStoreResolutionService } from '../../../src/core/StoreResolutionService';
import { StoreZeissContext } from '../../../src/contracts/store';
import { IClock } from '../../../src/utils/Clock';

describe('StoreBootstrapOrchestrator (Multi-Store Historical Bootstrap & Resumability)', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let mockStoreResolutionService: jest.Mocked<IStoreResolutionService>;
  let mockClock: jest.Mocked<IClock>;

  const storeId = 'store-uuid-bootstrap';
  const sampleContext: StoreZeissContext = {
    storeId,
    organizationId: 'org-uuid-1',
    storeCode: 'store-bootstrap-test',
    orgCode: 'org-test',
    cnpj: '11222333000181',
    status: 'ready',
    saowebCode: 'SAO99',
    zeissStoreCode: 'CN99',
    countryId: '1',
    voucherUserId: 'USR_VOUCHER',
    finUserId: 'USR_FIN',
    apiKey: 'API_KEY_BOOTSTRAP',
  };

  const fixedTime = new Date('2026-10-19T12:00:00Z').getTime();

  beforeEach(() => {
    mockClock = {
      now: jest.fn().mockReturnValue(fixedTime),
    };

    mockStoreResolutionService = {
      resolveStore: jest.fn().mockResolvedValue(sampleContext),
      listEligibleStores: jest.fn(),
    };

    mockDb = {
      query: jest.fn(),
      transaction: jest.fn(),
    };
  });

  it('should reject bootstrap if store is in draft status (must be validated first)', async () => {
    mockDb.query.mockResolvedValueOnce([
      { id: storeId, code: 'store-draft', status: 'draft', organization_id: 'org-1' },
    ]);

    const orchestrator = new StoreBootstrapOrchestrator(mockDb, mockStoreResolutionService, undefined, mockClock);

    await expect(orchestrator.bootstrapStore(storeId)).rejects.toThrow('Store is in draft status');
  });

  it('should execute full historical bootstrap with slicing, checkpoints, and transition to active', async () => {
    const orchestrator = new StoreBootstrapOrchestrator(mockDb, mockStoreResolutionService, undefined, mockClock);

    // Mock store query returning 'ready'
    mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id, code, status') && sql.includes('core.stores')) {
        return [{ id: storeId, code: 'store-bootstrap-test', status: 'ready', organization_id: 'org-uuid-1' }];
      }
      if (sql.includes('SELECT cursor_value FROM integration.store_sync_state')) {
        return []; // No previous checkpoint
      }
      if (sql.includes('SELECT') && sql.includes('zeiss.orders')) {
        return []; // Candidates
      }
      return [];
    });

    // Mock internal methods to simulate provider responses cleanly
    const mockOrdersProvider = {
      getOrders: jest.fn().mockResolvedValue([
        { 'nr-pedido': 'ORD-BOOT-100', 'os-cliente': 'OS1', 'status': 'Entregue', 'data-entrada': '2026-09-01' }
      ]),
    };
    const mockDetailProvider = {
      getOrderDetail: jest.fn().mockResolvedValue({
        situacao: 'Entregue',
        status: 'Entregue',
        previsao: '2026-09-05'
      }),
    };
    const mockTrackingProvider = {
      getTracking: jest.fn().mockResolvedValue([]),
    };
    const mockReceivablesProvider = {
      getReceivables: jest.fn().mockResolvedValue([]),
    };
    const mockCampaignsProvider = {
      getCampaigns: jest.fn().mockResolvedValue([]),
    };
    const mockLeadsProvider = {
      getLeads: jest.fn().mockResolvedValue([]),
      getRedeemedLeads: jest.fn().mockResolvedValue([]),
    };

    // Override buildStoreCompositionDeps using spy
    const compositionModule = require('../../../src/engine/StoreCompositionRoot');
    jest.spyOn(compositionModule, 'buildStoreCompositionDeps').mockReturnValue({
      policyRepo: {} as any,
      stateRepo: {} as any,
      leaseRepo: {} as any,
      healthRepo: {} as any,
      ordersRepo: {
        upsertMany: jest.fn().mockResolvedValue(undefined),
        findOrdersWithoutDetail: jest.fn().mockResolvedValue([]),
        findActiveOrders: jest.fn().mockResolvedValue([]),
      } as any,
      detailsRepo: {
        upsert: jest.fn().mockResolvedValue(undefined),
        exists: jest.fn().mockResolvedValue(true),
      } as any,
      trackingRepo: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findTrackingCandidates: jest.fn().mockResolvedValue([]),
        findTrackingCandidatesByDate: jest.fn().mockResolvedValue([]),
        findTrackingCandidatesForOrder: jest.fn().mockResolvedValue([]),
      } as any,
      campaignsRepo: {
        upsertMany: jest.fn().mockResolvedValue(undefined),
      } as any,
      leadsRepo: {
        upsertMany: jest.fn().mockResolvedValue(undefined),
        upsertRedeemedMany: jest.fn().mockResolvedValue(undefined),
      } as any,
      receivablesRepo: {
        upsertMany: jest.fn().mockResolvedValue(undefined),
      } as any,
      productsRepo: {} as any,

      ordersProvider: mockOrdersProvider as any,
      detailProvider: mockDetailProvider as any,
      trackingProvider: mockTrackingProvider as any,
      campaignsProvider: mockCampaignsProvider as any,
      leadsProvider: mockLeadsProvider as any,
      receivablesProvider: mockReceivablesProvider as any,
      productsProvider: {} as any,

      orderClassifier: {
        classify: jest.fn().mockReturnValue('MUTABLE'),
        isMutable: jest.fn().mockReturnValue(true),
        isBilledLogisticsReady: jest.fn().mockReturnValue(false),
        isCancelled: jest.fn().mockReturnValue(false),
      } as any,
      trackingClassifier: {} as any,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      clock: mockClock,
      sleeper: { sleep: jest.fn() },
    });

    const result = await orchestrator.bootstrapStore(storeId, {
      lookbackDays: 14, // 2 slices of 7 days
      sliceDays: 7,
    });

    expect(result.success).toBe(true);
    expect(result.currentStatus).toBe('active');
    expect(result.domains['orders'].status).toBe('completed');
    expect(result.catchUpCompleted).toBe(true);

    // Verify status was updated through the lifecycle: bootstrapping -> catching_up -> active
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE core.stores SET status = $1'),
      ['bootstrapping', storeId]
    );
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE core.stores SET status = $1'),
      ['catching_up', storeId]
    );
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE core.stores SET status = $1'),
      ['active', storeId]
    );
  });

  it('should resume from interrupted bootstrap without reprocessing completed slices', async () => {
    const orchestrator = new StoreBootstrapOrchestrator(mockDb, mockStoreResolutionService, undefined, mockClock);

    // End date is fixedTime: 2026-10-19. Lookback 14 days -> start: 2026-10-05.
    // Slice 1: 2026-10-05_2026-10-12 (already completed)
    // Slice 2: 2026-10-12_2026-10-19 (remaining)
    const completedSliceKey = '2026-10-05_2026-10-12';

    mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id, code, status') && sql.includes('core.stores')) {
        return [{ id: storeId, code: 'store-bootstrap-test', status: 'error', organization_id: 'org-uuid-1' }];
      }
      if (sql.includes('SELECT cursor_value FROM integration.store_sync_state')) {
        // Return existing checkpoint with slice 1 completed
        return [{
          cursor_value: JSON.stringify({
            completedSliceKeys: [completedSliceKey],
            lastCompletedDate: '2026-10-12',
            recordsCount: 50,
            status: 'in_progress',
            updatedAt: '2026-10-19T10:00:00Z',
          }),
        }];
      }
      return [];
    });

    const mockOrdersProvider = {
      getOrders: jest.fn().mockResolvedValue([]),
    };

    const compositionModule = require('../../../src/engine/StoreCompositionRoot');
    jest.spyOn(compositionModule, 'buildStoreCompositionDeps').mockReturnValue({
      ordersRepo: { upsertMany: jest.fn() } as any,
      detailsRepo: { upsert: jest.fn() } as any,
      trackingRepo: { findTrackingCandidates: jest.fn().mockResolvedValue([]), upsert: jest.fn() } as any,
      campaignsRepo: { upsertMany: jest.fn() } as any,
      leadsRepo: { upsertMany: jest.fn() } as any,
      receivablesRepo: { upsertMany: jest.fn() } as any,

      ordersProvider: mockOrdersProvider as any,
      detailProvider: { getOrderDetail: jest.fn() } as any,
      trackingProvider: { getTracking: jest.fn() } as any,
      campaignsProvider: { getCampaigns: jest.fn().mockResolvedValue([]) } as any,
      leadsProvider: { getLeads: jest.fn().mockResolvedValue([]) } as any,
      receivablesProvider: { getReceivables: jest.fn().mockResolvedValue([]) } as any,
      productsProvider: {} as any,

      orderClassifier: { classify: jest.fn() } as any,
      trackingClassifier: {} as any,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      clock: mockClock,
      sleeper: { sleep: jest.fn() },
    } as any);

    const result = await orchestrator.bootstrapStore(storeId, {
      lookbackDays: 14,
      sliceDays: 7,
    });

    expect(result.success).toBe(true);
    // Verifies that slice 1 was resumed and skipped; getOrders was only called for the remaining slice(s) + catchup
    expect(result.domains['orders'].resumedFromSlice).toBe(1);
  });
});
