import { CentralMultiStoreScheduler } from '../../../src/engine/CentralMultiStoreScheduler';
import { ISyncPolicyRepository, SyncPolicy } from '../../../src/contracts/repositories';
import { IStoreResolutionService } from '../../../src/core/StoreResolutionService';
import { IDatabaseExecutor } from '../../../src/config/db';
import { StoreZeissContext } from '../../../src/contracts/store';
import { IClock, ISleeper } from '../../../src/utils/Clock';
import { JobRegistry, IJob, JobContext, JobResult } from '../../../src/engine/JobRegistry';
import * as StoreCompositionRootModule from '../../../src/engine/StoreCompositionRoot';

describe('CentralMultiStoreScheduler (Single Central Map, Segregated Store Execution)', () => {
  let mockGlobalPolicyRepo: jest.Mocked<ISyncPolicyRepository>;
  let mockStoreResolutionService: jest.Mocked<IStoreResolutionService>;
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let mockClock: jest.Mocked<IClock>;
  let mockSleeper: jest.Mocked<ISleeper>;

  const sampleCentralPolicy: SyncPolicy = {
    provider: 'zeiss',
    domain: 'orders',
    operation: 'discovery',
    enabled: true,
    interval_seconds: 300,
    lookback_seconds: 86400,
    timeout_seconds: 30,
    lease_ttl_seconds: 60,
    max_retries: 3,
    retry_delay_seconds: 5,
    operation_config: { maxRangeDays: 7, statusFilter: 'TODOS' },
  };

  const store1Context: StoreZeissContext = {
    storeId: 'store-uuid-1',
    organizationId: 'org-1',
    storeCode: 'store-1',
    orgCode: 'org-group',
    cnpj: '11222333000181',
    status: 'active',
    saowebCode: 'SAO01',
    zeissStoreCode: 'CN01',
    countryId: '1',
    voucherUserId: 'U1',
    finUserId: 'F1',
    apiKey: 'KEY_STORE_1',
  };

  const store2Context: StoreZeissContext = {
    storeId: 'store-uuid-2',
    organizationId: 'org-1',
    storeCode: 'store-2',
    orgCode: 'org-group',
    cnpj: '00000000000191',
    status: 'active',
    saowebCode: 'SAO02',
    zeissStoreCode: 'CN02',
    countryId: '1',
    voucherUserId: 'U2',
    finUserId: 'F2',
    apiKey: 'KEY_STORE_2',
  };

  const suspendedStoreContext: StoreZeissContext = {
    ...store1Context,
    storeId: 'store-uuid-3',
    storeCode: 'store-suspended',
    status: 'suspended',
  };

  beforeEach(() => {
    mockGlobalPolicyRepo = {
      findEnabledByProvider: jest.fn().mockResolvedValue([sampleCentralPolicy]),
      findAllEnabled: jest.fn(),
      findByKey: jest.fn(),
    };

    mockStoreResolutionService = {
      listEligibleStores: jest.fn().mockResolvedValue([store1Context, store2Context, suspendedStoreContext]),
      resolveStore: jest.fn(),
    };

    mockDb = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(),
    };

    mockClock = {
      now: jest.fn().mockReturnValue(1700000000000),
    };

    mockSleeper = {
      sleep: jest.fn().mockImplementation((ms?: number) => new Promise(resolve => setTimeout(resolve, Math.min(ms || 5, 10)))),
    };
  });

  it('should enforce a single central policy map and discover only active stores', async () => {
    const scheduler = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: mockDb,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    // Mock lease acquisition returning true for both active stores
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('integration.store_sync_leases') && sql.includes('INSERT INTO')) {
        return [{ acquired: true }];
      }
      if (sql.includes('integration.store_sync_state') && sql.includes('SELECT')) {
        return []; // No previous state
      }
      return [];
    });

    // Mock executeStorePolicy internal resolution
    mockStoreResolutionService.resolveStore.mockImplementation(async (id: string) => {
      if (id === 'store-uuid-1') return store1Context;
      if (id === 'store-uuid-2') return store2Context;
      throw new Error('Not found');
    });

    const tickResult = await scheduler.tick('zeiss');

    // 1. Verifies that policies are read once centrally from globalPolicyRepo
    expect(mockGlobalPolicyRepo.findEnabledByProvider).toHaveBeenCalledTimes(1);
    expect(mockGlobalPolicyRepo.findEnabledByProvider).toHaveBeenCalledWith('zeiss');

    // 2. Verifies dynamic discovery of eligible stores
    expect(mockStoreResolutionService.listEligibleStores).toHaveBeenCalledTimes(1);

    // 3. Verifies that only active stores are ticked (2 active, suspended is excluded)
    expect(tickResult.totalPolicies).toBe(1);
    expect(tickResult.totalActiveStores).toBe(2);
  });

  it('should isolate store execution so failure in Store 1 does not halt Store 2', async () => {
    const scheduler = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: mockDb,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    let store1Executed = false;
    let store2Executed = false;

    // Spy on executeStorePolicy
    jest.spyOn(scheduler, 'executeStorePolicy').mockImplementation(async (store: StoreZeissContext) => {
      if (store.storeId === 'store-uuid-1') {
        store1Executed = true;
        throw new Error('Simulated network timeout querying ZEISS ORD-001 for Store 1');
      }
      if (store.storeId === 'store-uuid-2') {
        store2Executed = true;
        return 'EXECUTED_SUCCESS';
      }
      return null;
    });

    const tickResult = await scheduler.tick('zeiss');

    // Both stores were attempted
    expect(store1Executed).toBe(true);
    expect(store2Executed).toBe(true);

    // Store 2 succeeded and was recorded in the outcomes
    const store2Outcome = tickResult.executions.find(e => e.storeId === 'store-uuid-2');
    expect(store2Outcome).toBeDefined();
    expect(store2Outcome?.result).toBe('EXECUTED_SUCCESS');
  });

  it('should skip execution for a store if its lease cannot be acquired (concurrency prevention)', async () => {
    const scheduler = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: mockDb,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    // Simulate Lease Acquisition Failure (another worker currently holds lease for Store 1)
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('integration.store_sync_leases') && sql.includes('INSERT INTO')) {
        return []; // 0 rows inserted/updated -> lease not acquired
      }
      return [];
    });

    const result = await scheduler.executeStorePolicy(store1Context, sampleCentralPolicy, { force: true });

    expect(result).toBe('SKIPPED_LEASE');
  });

  // -------------------------------------------------------------------------
  // ACH-01: Checkpoint lido após aquisição do lease
  // -------------------------------------------------------------------------
  it('ACH-01: should read authoritative checkpoint AFTER lease acquisition to prevent starting with stale cursor', async () => {
    const scheduler = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: mockDb,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    let stateReadsCount = 0;
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('integration.store_sync_leases') && sql.includes('INSERT INTO')) {
        return [{ acquired: true }];
      }
      if (sql.includes('integration.store_sync_leases') && sql.includes('UPDATE')) {
        return [{ renewed: true }]; // keepalive / stillOwner renewal
      }
      if (sql.includes('integration.store_sync_state') && sql.includes('SELECT')) {
        stateReadsCount++;
        if (stateReadsCount === 1) {
          // Pre-lease read: stale cursor
          return [{
            provider: 'zeiss',
            domain: 'orders',
            operation: 'discovery',
            last_sync: new Date(1699990000000),
            cursor_value: JSON.stringify({ lastEndDate: '2026-10-01' })
          }];
        }
        // Post-lease read (ACH-01): fresh cursor updated by concurrent worker
        return [{
          provider: 'zeiss',
          domain: 'orders',
          operation: 'discovery',
          last_sync: new Date(1699995000000),
          cursor_value: JSON.stringify({ lastEndDate: '2026-10-15' })
        }];
      }
      return [];
    });

    let capturedJobContext: JobContext | undefined;
    const mockJob: IJob = {
      execute: jest.fn().mockImplementation(async (ctx: JobContext): Promise<JobResult> => {
        capturedJobContext = ctx;
        return { success: true, retryable: false, cursorValue: JSON.stringify({ lastEndDate: '2026-10-20' }) };
      })
    };

    const mockRegistry = new JobRegistry();
    mockRegistry.register('zeiss', 'orders', 'discovery', mockJob);

    jest.spyOn(StoreCompositionRootModule, 'buildStoreCompositionRoot').mockReturnValue({
      registry: mockRegistry
    } as any);

    const result = await scheduler.executeStorePolicy(store1Context, sampleCentralPolicy, { force: true });

    expect(result).toBe('EXECUTED_SUCCESS');
    expect(stateReadsCount).toBeGreaterThanOrEqual(2);
    // Verifies the job started with the FRESH post-lease cursor (2026-10-15), NOT the stale pre-lease one (2026-10-01)
    expect(capturedJobContext?.lastSyncState?.cursor_value).toBe(JSON.stringify({ lastEndDate: '2026-10-15' }));
  });

  it('ACH-01: should release lease and return SKIPPED_NOT_DUE if post-lease state reveals policy is no longer due', async () => {
    const scheduler = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: mockDb,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    let leaseReleased = false;
    let stateReadsCount = 0;

    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('integration.store_sync_leases') && sql.includes('INSERT INTO')) {
        return [{ acquired: true }];
      }
      if (sql.includes('DELETE FROM integration.store_sync_leases')) {
        leaseReleased = true;
        return [];
      }
      if (sql.includes('integration.store_sync_state') && sql.includes('SELECT')) {
        stateReadsCount++;
        if (stateReadsCount === 1) {
          // Pre-lease: last_sync was 400s ago (due)
          return [{
            provider: 'zeiss',
            domain: 'orders',
            operation: 'discovery',
            last_sync: new Date(1700000000000 - 400000),
            cursor_value: 'cursor-1'
          }];
        }
        // Post-lease: another concurrent worker just ran it 10s ago (no longer due!)
        return [{
          provider: 'zeiss',
          domain: 'orders',
          operation: 'discovery',
          last_sync: new Date(1700000000000 - 10000),
          cursor_value: 'cursor-2'
        }];
      }
      return [];
    });

    const result = await scheduler.executeStorePolicy(store1Context, sampleCentralPolicy, { force: false });

    expect(result).toBe('SKIPPED_NOT_DUE');
    expect(leaseReleased).toBe(true);
  });

  // -------------------------------------------------------------------------
  // ACH-02: Timeout e cancelamento de jobs (Cooperative e Uncooperative)
  // -------------------------------------------------------------------------
  it('ACH-02: should handle cooperative job timeout by aborting signal, reporting failure and releasing lease', async () => {
    const policyWithShortTimeout: SyncPolicy = {
      ...sampleCentralPolicy,
      timeout_seconds: 1, // 1s timeout
      max_retries: 0
    };

    const scheduler = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: mockDb,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    let leaseReleased = false;
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('integration.store_sync_leases') && sql.includes('INSERT INTO')) {
        return [{ acquired: true }];
      }
      if (sql.includes('integration.store_sync_leases') && sql.includes('UPDATE')) {
        return [{ renewed: true }];
      }
      if (sql.includes('DELETE FROM integration.store_sync_leases')) {
        leaseReleased = true;
        return [];
      }
      return [];
    });

    // Cooperative job: listens to abortSignal and throws upon abort
    const cooperativeJob: IJob = {
      execute: jest.fn().mockImplementation(async (ctx: JobContext): Promise<JobResult> => {
        return new Promise((resolve, reject) => {
          ctx.abortSignal.addEventListener('abort', () => {
            reject(new Error('Job aborted cleanly'));
          });
        });
      })
    };

    const mockRegistry = new JobRegistry();
    mockRegistry.register('zeiss', 'orders', 'discovery', cooperativeJob);
    jest.spyOn(StoreCompositionRootModule, 'buildStoreCompositionRoot').mockReturnValue({
      registry: mockRegistry
    } as any);

    const result = await scheduler.executeStorePolicy(store1Context, policyWithShortTimeout, { force: true });

    expect(result).toBe('EXECUTED_FAILED');
    expect(leaseReleased).toBe(true);
  });

  it('ACH-02: should contain uncooperative job on timeout: disarm keepalive, halt retries without concurrent spawn, and withhold immediate lease release', async () => {
    const policyWithRetries: SyncPolicy = {
      ...sampleCentralPolicy,
      timeout_seconds: 1,
      max_retries: 3, // multiple retries configured!
      retry_delay_seconds: 1
    };

    const scheduler = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: mockDb,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    let leaseReleasedImmediately = false;
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('integration.store_sync_leases') && sql.includes('INSERT INTO')) {
        return [{ acquired: true }];
      }
      if (sql.includes('DELETE FROM integration.store_sync_leases')) {
        leaseReleasedImmediately = true;
        return [];
      }
      return [];
    });

    let executionAttempts = 0;
    // Uncooperative job: completely ignores abortSignal and its promise never settles
    const uncooperativeJob: IJob = {
      execute: jest.fn().mockImplementation(async (): Promise<JobResult> => {
        executionAttempts++;
        return new Promise(() => {}); // never resolves or rejects
      })
    };

    const mockRegistry = new JobRegistry();
    mockRegistry.register('zeiss', 'orders', 'discovery', uncooperativeJob);
    jest.spyOn(StoreCompositionRootModule, 'buildStoreCompositionRoot').mockReturnValue({
      registry: mockRegistry
    } as any);

    const result = await scheduler.executeStorePolicy(store1Context, policyWithRetries, { force: true });

    expect(result).toBe('EXECUTED_FAILED');
    // Crucial containment: despite max_retries = 3, only 1 attempt was launched because attempt 1 is still pending in event loop!
    expect(executionAttempts).toBe(1);
    // Immediate lease release is withheld so the lease TTL acts as an isolation fence against external collision
    expect(leaseReleasedImmediately).toBe(false);
  });
});
