import { CentralMultiStoreScheduler } from '../../../src/engine/CentralMultiStoreScheduler';
import { ISyncPolicyRepository, SyncPolicy } from '../../../src/contracts/repositories';
import { IStoreResolutionService } from '../../../src/core/StoreResolutionService';
import { IDatabaseExecutor } from '../../../src/config/db';
import { StoreZeissContext } from '../../../src/contracts/store';
import { IClock, ISleeper } from '../../../src/utils/Clock';
import { JobRegistry, IJob, JobContext, JobResult } from '../../../src/engine/JobRegistry';
import * as StoreCompositionRootModule from '../../../src/engine/StoreCompositionRoot';
import { FencedDatabaseExecutor, StaleWriteError } from '../../../src/engine/FencedDatabaseExecutor';
import { PgStoreSyncStateRepository } from '../../../src/repositories/postgres/StoreSyncStateRepository';

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

  it('ACH-02: should prevent stale writes when uncooperative Job A attempts to persist after lease expiration and acquisition by Instance B', async () => {
    // Shared simulated database state
    let activeLease: {
      store_id: string;
      provider: string;
      domain: string;
      operation: string;
      owner_token: string;
      expires_at: number; // timestamp ms
    } | null = null;

    let currentState: {
      cursor_value: string | null;
      last_sync: Date | null;
    } = { cursor_value: null, last_sync: null };

    const ordersTable: Array<{ order_number: string; store_id: string; payload: string }> = [];
    const healthTable: Map<string, { status: string; last_success?: Date; last_failure?: Date }> = new Map();

    // Factory to create DB executor for simulated Postgres
    const createSimulatedDb = () => {
      const db: IDatabaseExecutor = {
        query: jest.fn().mockImplementation(async (sql: string, params?: any[]) => {
          // store_sync_state atomic upsert with fencing
          if (sql.includes('integration.store_sync_state') && sql.includes('INSERT INTO')) {
            const [storeId, provider, domain, operation, lastSync, cursorValue, leaseToken] = params || [];
            // Fencing check: does caller leaseToken match activeLease.owner_token?
            if (activeLease && activeLease.owner_token === leaseToken && activeLease.expires_at >= Date.now()) {
              currentState = { cursor_value: cursorValue, last_sync: lastSync };
              return [{ store_id: storeId }];
            }
            // Mismatch or expired: 0 rows returned
            return [];
          }

          // store_sync_leases tryAcquire
          if (sql.includes('INSERT INTO integration.store_sync_leases')) {
            const [storeId, provider, domain, operation, ownerToken, ttlSeconds] = params || [];
            const now = Date.now();
            if (!activeLease || activeLease.expires_at < now) {
              activeLease = {
                store_id: storeId,
                provider,
                domain,
                operation,
                owner_token: ownerToken,
                expires_at: now + ttlSeconds * 1000
              };
              return [{ acquired: true }];
            }
            return []; // lease held by someone else and not expired
          }

          // store_sync_leases FOR UPDATE / findActive
          if (sql.includes('FROM integration.store_sync_leases') && sql.includes('SELECT') && !sql.includes('integration.store_sync_state') && !sql.includes('integration.store_provider_health')) {
            if (sql.includes('FOR UPDATE')) {
              if (activeLease) {
                return [{
                  store_id: activeLease.store_id,
                  provider: activeLease.provider,
                  domain: activeLease.domain,
                  operation: activeLease.operation,
                  owner_token: activeLease.owner_token,
                  expires_at: new Date(activeLease.expires_at),
                  is_valid: activeLease.expires_at >= Date.now()
                }];
              }
              return [];
            }
            if (activeLease && activeLease.expires_at >= Date.now()) {
              return [{
                store_id: activeLease.store_id,
                provider: activeLease.provider,
                domain: activeLease.domain,
                operation: activeLease.operation,
                owner_token: activeLease.owner_token,
                expires_at: new Date(activeLease.expires_at)
              }];
            }
            return [];
          }

          // store_sync_leases renew
          if (sql.includes('UPDATE integration.store_sync_leases')) {
            const [storeId, provider, domain, operation, ownerToken, ttlSeconds] = params || [];
            if (activeLease && activeLease.owner_token === ownerToken && activeLease.expires_at >= Date.now()) {
              activeLease.expires_at = Date.now() + ttlSeconds * 1000;
              return [{ renewed: true }];
            }
            return [];
          }

          // store_sync_leases release
          if (sql.includes('DELETE FROM integration.store_sync_leases')) {
            const [storeId, provider, domain, operation, ownerToken] = params || [];
            if (activeLease && activeLease.owner_token === ownerToken) {
              activeLease = null;
            }
            return [];
          }

          // store_sync_state SELECT
          if (sql.includes('integration.store_sync_state') && sql.includes('SELECT')) {
            return [{
              provider: 'zeiss',
              domain: 'orders',
              operation: 'discovery',
              last_sync: currentState.last_sync,
              cursor_value: currentState.cursor_value
            }];
          }

          // zeiss.orders INSERT
          if (sql.includes('zeiss.orders') && sql.includes('INSERT')) {
            const [orderNumber, osNumber, status, codsit, entryDate, expectedDate, storeId] = params || [];
            ordersTable.push({ order_number: orderNumber, store_id: storeId, payload: status });
            return [];
          }

          // store_provider_health SELECT
          if (sql.includes('integration.store_provider_health') && sql.includes('SELECT') && !sql.includes('INSERT')) {
            const [storeId, provider, domain, operation] = params || [];
            const key = `${storeId}:${provider}:${domain}:${operation}`;
            const record = healthTable.get(key);
            if (record) {
              return [{
                provider,
                domain,
                operation,
                status: record.status,
                last_success: record.last_success,
                last_failure: record.last_failure
              }];
            }
            return [];
          }

          // store_provider_health INSERT
          if (sql.includes('integration.store_provider_health') && sql.includes('INSERT')) {
            const [storeId, provider, domain, operation, leaseToken] = params || [];
            const key = `${storeId}:${provider}:${domain}:${operation}`;
            const isSuccess = sql.includes("'HEALTHY'");

            // If query enforces atomic lease check via WHERE EXISTS
            if (sql.includes('WHERE EXISTS') && sql.includes('integration.store_sync_leases')) {
              const matchesLease = activeLease &&
                activeLease.owner_token === leaseToken &&
                activeLease.expires_at >= Date.now();
              if (!matchesLease) {
                return []; // Stale update rejected: zero rows affected
              }
            }

            const existing = healthTable.get(key) || { status: isSuccess ? 'HEALTHY' : 'DEGRADED' };
            if (isSuccess) {
              existing.status = 'HEALTHY';
              existing.last_success = new Date();
            } else {
              existing.status = 'DEGRADED';
              existing.last_failure = new Date();
            }
            healthTable.set(key, existing);
            return [{ store_id: storeId }];
          }

          return [];
        }),
        transaction: jest.fn().mockImplementation(async (cb: (client: IDatabaseExecutor) => Promise<any>) => {
          return cb(db);
        })
      };
      return db;
    };

    const dbA = createSimulatedDb();
    const dbB = createSimulatedDb();

    // 1. Instância A
    const schedulerA = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: dbA,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    // 2. Instância B
    const schedulerB = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: dbB,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    const shortPolicy: SyncPolicy = {
      ...sampleCentralPolicy,
      timeout_seconds: 1,
      lease_ttl_seconds: 30, // 30s lease TTL
      max_retries: 0
    };

    // Deferred promise for uncooperative Job A
    let triggerJobAPersist!: () => Promise<void>;
    let jobAPersistError: Error | null = null;

    const uncooperativeJobA: IJob = {
      execute: jest.fn().mockImplementation(async (ctx: JobContext): Promise<JobResult> => {
        // Expose function for Job A to attempt persistence later, after lease expiry
        triggerJobAPersist = async () => {
          try {
            // Attempt to write orders using FencedDatabaseExecutor bound to Instance A
            const fencedDbA = new FencedDatabaseExecutor(dbA, {
              storeId: store1Context.storeId,
              provider: 'zeiss',
              domain: 'orders',
              operation: 'discovery',
              ownerToken: (schedulerA as any).workerId
            });
            await fencedDbA.query('INSERT INTO zeiss.orders (order_number, store_id) VALUES ($1, $2)', [
              'ORD-STALE-FROM-A',
              store1Context.storeId
            ]);
          } catch (err: any) {
            jobAPersistError = err;
            throw err;
          }
        };

        // Job A ignores abortSignal and never resolves synchronously
        return new Promise(() => {});
      })
    };

    const normalJobB: IJob = {
      execute: jest.fn().mockImplementation(async (ctx: JobContext): Promise<JobResult> => {
        const fencedDbB = new FencedDatabaseExecutor(dbB, {
          storeId: store1Context.storeId,
          provider: 'zeiss',
          domain: 'orders',
          operation: 'discovery',
          ownerToken: (schedulerB as any).workerId
        });
        await fencedDbB.query('INSERT INTO zeiss.orders (order_number, store_id) VALUES ($1, $2)', [
          'ORD-FRESH-FROM-B',
          store1Context.storeId
        ]);
        return {
          success: true,
          retryable: false,
          cursorValue: JSON.stringify({ lastEndDate: '2026-10-20' })
        };
      })
    };

    // Step 1: Instância A adquire lease e inicia job uncooperative
    const mockRegistryA = new JobRegistry();
    mockRegistryA.register('zeiss', 'orders', 'discovery', uncooperativeJobA);
    jest.spyOn(StoreCompositionRootModule, 'buildStoreCompositionRoot').mockReturnValueOnce({
      registry: mockRegistryA
    } as any);

    const resultA = await schedulerA.executeStorePolicy(store1Context, shortPolicy, { force: true });
    expect(resultA).toBe('EXECUTED_FAILED');
    expect((activeLease as any)?.owner_token).toBe((schedulerA as any).workerId);

    // Step 2: O lease de A expira (simulamos avanço do tempo além de lease_ttl_seconds)
    (activeLease as any).expires_at = Date.now() - 1000;

    // Step 3: Instância B adquire novo lease
    const mockRegistryB = new JobRegistry();
    mockRegistryB.register('zeiss', 'orders', 'discovery', normalJobB);
    jest.spyOn(StoreCompositionRootModule, 'buildStoreCompositionRoot').mockReturnValueOnce({
      registry: mockRegistryB
    } as any);

    const resultB = await schedulerB.executeStorePolicy(store1Context, shortPolicy, { force: true });
    expect(resultB).toBe('EXECUTED_SUCCESS');
    expect(currentState.cursor_value).toBe(JSON.stringify({ lastEndDate: '2026-10-20' }));
    expect(ordersTable.some(o => o.order_number === 'ORD-FRESH-FROM-B')).toBe(true);

    // Step 4: Instância A (job órfão) tenta persistir dados após perder sua autorização
    await expect(triggerJobAPersist()).rejects.toThrow(StaleWriteError);
    expect(jobAPersistError).toBeInstanceOf(StaleWriteError);

    // Step 5: Verifica que a escrita obsoleta de A NUNCA entrou na tabela de pedidos
    expect(ordersTable.some(o => o.order_number === 'ORD-STALE-FROM-A')).toBe(false);

    // Step 6: Instância A também tenta avançar o cursor via stateRepo.upsert com token obsoleto
    const stateRepoA = new PgStoreSyncStateRepository(dbA, store1Context.storeId);
    await expect(
      stateRepoA.upsert({
        provider: 'zeiss',
        domain: 'orders',
        operation: 'discovery',
        last_sync: new Date(),
        cursor_value: JSON.stringify({ lastEndDate: '2026-01-01' }) // Stale regressed cursor!
      }, (schedulerA as any).workerId)
    ).rejects.toThrow(/STALE_WRITE_REJECTED/);

    // Step 7: B continua corretamente com seu cursor e dados intactos, sem corrupção ou regressão
    expect(currentState.cursor_value).toBe(JSON.stringify({ lastEndDate: '2026-10-20' }));
    expect(ordersTable.length).toBe(1);
    expect(ordersTable[0].order_number).toBe('ORD-FRESH-FROM-B');
  });

  it('ACH-02: should prevent tardy/stale Instance A from overwriting store_provider_health after Instance B succeeded', async () => {
    let activeLease: {
      store_id: string;
      provider: string;
      domain: string;
      operation: string;
      owner_token: string;
      expires_at: number;
    } | null = null;

    const healthTable: Map<string, { status: string; last_success?: Date; last_failure?: Date }> = new Map();

    const createSimulatedDb = () => {
      const db: IDatabaseExecutor = {
        query: jest.fn().mockImplementation(async (sql: string, params?: any[]) => {
          // store_sync_leases tryAcquire
          if (sql.includes('integration.store_sync_leases') && sql.includes('INSERT') && !sql.includes('integration.store_sync_state') && !sql.includes('integration.store_provider_health')) {
            const [storeId, provider, domain, operation, ownerToken, ttlSeconds] = params || [];
            const now = Date.now();
            if (!activeLease || activeLease.expires_at < now) {
              activeLease = {
                store_id: storeId,
                provider,
                domain,
                operation,
                owner_token: ownerToken,
                expires_at: now + ttlSeconds * 1000
              };
              return [{ acquired: true }];
            }
            return [];
          }

          // store_sync_leases FOR UPDATE / findActive
          if (sql.includes('FROM integration.store_sync_leases') && sql.includes('SELECT') && !sql.includes('integration.store_sync_state') && !sql.includes('integration.store_provider_health')) {
            if (sql.includes('FOR UPDATE')) {
              if (activeLease) {
                return [{
                  store_id: activeLease.store_id,
                  provider: activeLease.provider,
                  domain: activeLease.domain,
                  operation: activeLease.operation,
                  owner_token: activeLease.owner_token,
                  expires_at: new Date(activeLease.expires_at),
                  is_valid: activeLease.expires_at >= Date.now()
                }];
              }
              return [];
            }
            if (activeLease && activeLease.expires_at >= Date.now()) {
              return [{
                store_id: activeLease.store_id,
                provider: activeLease.provider,
                domain: activeLease.domain,
                operation: activeLease.operation,
                owner_token: activeLease.owner_token,
                expires_at: new Date(activeLease.expires_at)
              }];
            }
            return [];
          }

          // store_sync_leases renew
          if (sql.includes('UPDATE integration.store_sync_leases')) {
            const [storeId, provider, domain, operation, ownerToken, ttlSeconds] = params || [];
            if (activeLease && activeLease.owner_token === ownerToken && activeLease.expires_at >= Date.now()) {
              activeLease.expires_at = Date.now() + ttlSeconds * 1000;
              return [{ renewed: true }];
            }
            return [];
          }

          // store_sync_leases release
          if (sql.includes('DELETE FROM integration.store_sync_leases')) {
            const [storeId, provider, domain, operation, ownerToken] = params || [];
            if (activeLease && activeLease.owner_token === ownerToken) {
              activeLease = null;
            }
            return [];
          }

          // store_sync_state SELECT / INSERT
          if (sql.includes('integration.store_sync_state')) {
            if (sql.includes('INSERT INTO')) {
              const [storeId, provider, domain, operation, lastSync, cursorValue, leaseToken] = params || [];
              if (activeLease && activeLease.owner_token === leaseToken && activeLease.expires_at >= Date.now()) {
                return [{ store_id: storeId }];
              }
              return [];
            }
            return [{ provider: 'zeiss', domain: 'orders', operation: 'discovery', last_sync: null, cursor_value: null }];
          }

          // store_provider_health SELECT
          if (sql.includes('integration.store_provider_health') && sql.includes('SELECT') && !sql.includes('INSERT')) {
            const [storeId, provider, domain, operation] = params || [];
            const key = `${storeId}:${provider}:${domain}:${operation}`;
            const record = healthTable.get(key);
            if (record) {
              return [{
                provider,
                domain,
                operation,
                status: record.status,
                last_success: record.last_success,
                last_failure: record.last_failure
              }];
            }
            return [];
          }

          // store_provider_health INSERT
          if (sql.includes('integration.store_provider_health') && sql.includes('INSERT')) {
            const [storeId, provider, domain, operation, leaseToken] = params || [];
            const key = `${storeId}:${provider}:${domain}:${operation}`;
            const isSuccess = sql.includes("'HEALTHY'");

            // If query enforces atomic lease check via WHERE EXISTS
            if (sql.includes('WHERE EXISTS') && sql.includes('integration.store_sync_leases')) {
              const matchesLease = activeLease &&
                activeLease.owner_token === leaseToken &&
                activeLease.expires_at >= Date.now();
              if (!matchesLease) {
                return []; // Stale update rejected: zero rows affected
              }
            }

            const existing = healthTable.get(key) || { status: isSuccess ? 'HEALTHY' : 'DEGRADED' };
            if (isSuccess) {
              existing.status = 'HEALTHY';
              existing.last_success = new Date();
            } else {
              existing.status = 'DEGRADED';
              existing.last_failure = new Date();
            }
            healthTable.set(key, existing);
            return [{ store_id: storeId }];
          }

          return [];
        }),
        transaction: jest.fn().mockImplementation(async (cb: (client: IDatabaseExecutor) => Promise<any>) => {
          return cb(db);
        })
      };
      return db;
    };

    const dbA = createSimulatedDb();
    const dbB = createSimulatedDb();

    const schedulerA = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: dbA,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    const schedulerB = new CentralMultiStoreScheduler({
      globalPolicyRepo: mockGlobalPolicyRepo,
      storeResolutionService: mockStoreResolutionService,
      db: dbB,
      clock: mockClock,
      sleeper: mockSleeper,
    });

    const testPolicy: SyncPolicy = {
      ...sampleCentralPolicy,
      timeout_seconds: 5,
      lease_ttl_seconds: 30,
      max_retries: 0
    };

    // Deferred promise for Job A
    let resolveJobA!: (result: JobResult) => void;
    const jobAPromise = new Promise<JobResult>((resolve) => {
      resolveJobA = resolve;
    });

    const tardyJobA: IJob = {
      execute: jest.fn().mockImplementation(async (): Promise<JobResult> => {
        return jobAPromise;
      })
    };

    const successJobB: IJob = {
      execute: jest.fn().mockImplementation(async (): Promise<JobResult> => {
        return {
          success: true,
          retryable: false,
          cursorValue: JSON.stringify({ lastEndDate: '2026-10-20' })
        };
      })
    };

    // Step 1: Instância A adquire lease e inicia execução do job A
    const mockRegistryA = new JobRegistry();
    mockRegistryA.register('zeiss', 'orders', 'discovery', tardyJobA);
    jest.spyOn(StoreCompositionRootModule, 'buildStoreCompositionRoot').mockReturnValueOnce({
      registry: mockRegistryA
    } as any);

    const execPromiseA = schedulerA.executeStorePolicy(store1Context, testPolicy, { force: true });

    // Aguarda tick para Instância A adquirir lease e entrar em execução
    await new Promise(r => setTimeout(r, 20));
    expect((activeLease as any)?.owner_token).toBe((schedulerA as any).workerId);

    // Step 2: O lease de A expira enquanto o job A ainda está suspenso
    (activeLease as any).expires_at = Date.now() - 1000;

    // Step 3: Instância B adquire novo lease e executa com sucesso
    const mockRegistryB = new JobRegistry();
    mockRegistryB.register('zeiss', 'orders', 'discovery', successJobB);
    jest.spyOn(StoreCompositionRootModule, 'buildStoreCompositionRoot').mockReturnValueOnce({
      registry: mockRegistryB
    } as any);

    const resultB = await schedulerB.executeStorePolicy(store1Context, testPolicy, { force: true });
    expect(resultB).toBe('EXECUTED_SUCCESS');

    // Verifica que Instância B registrou status HEALTHY em store_provider_health
    const healthKey = `${store1Context.storeId}:zeiss:orders:discovery`;
    expect(healthTable.get(healthKey)?.status).toBe('HEALTHY');

    // Step 4: Job A finalmente conclui (tardiamente)
    resolveJobA({
      success: true,
      retryable: false,
      cursorValue: JSON.stringify({ lastEndDate: '2026-10-19' })
    });

    const resultA = await execPromiseA;
    expect(resultA).toBe('EXECUTED_FAILED');

    // Step 5: CRÍTICO: O estado registrado por B DEVE permanecer HEALTHY e não ser sobrescrito por A!
    expect(healthTable.get(healthKey)?.status).toBe('HEALTHY');

    // Step 6: Falhas legítimas enquanto detém o lease continuam devidamente observáveis
    const failingJob: IJob = {
      execute: jest.fn().mockResolvedValue({
        success: false,
        retryable: false,
        error: new Error('Legitimate ZEISS API Failure')
      })
    };
    const mockRegistryFail = new JobRegistry();
    mockRegistryFail.register('zeiss', 'orders', 'discovery', failingJob);
    jest.spyOn(StoreCompositionRootModule, 'buildStoreCompositionRoot').mockReturnValueOnce({
      registry: mockRegistryFail
    } as any);

    const failResult = await schedulerB.executeStorePolicy(store1Context, testPolicy, { force: true });
    expect(failResult).toBe('EXECUTED_FAILED');
    expect(healthTable.get(healthKey)?.status).toBe('DEGRADED');
  });
});
