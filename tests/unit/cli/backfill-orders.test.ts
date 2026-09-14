import { BackfillOrchestrator } from '../../../src/engine/BackfillOrchestrator';
import { NullLogger } from '../../../src/observability/Logger';
import { SyncPolicy, SyncState } from '../../../src/contracts/repositories';
import { OrderLifecycleStage } from '../../../src/engine/Classifiers';

describe('BackfillOrchestrator', () => {
  let deps: any;

  beforeEach(() => {
    deps = {
      ordersProvider: { getOrders: jest.fn().mockResolvedValue([]) },
      detailProvider: { getOrderDetail: jest.fn().mockResolvedValue({ situacao: 'ok' }) },
      ordersRepo: {
        upsertMany: jest.fn().mockResolvedValue([]),
        findOrdersWithoutDetail: jest.fn().mockResolvedValue([]),
        findActiveOrders: jest.fn().mockResolvedValue([]),
      },
      detailsRepo: {
        upsert: jest.fn().mockResolvedValue(undefined),
        exists: jest.fn().mockResolvedValue(false),
      },
      policyRepo: {
        findByKey: jest.fn().mockResolvedValue({ enabled: true, lease_ttl_seconds: 300, operation_config: { maxRangeDays: 30, statusFilter: 'TODOS' } } as unknown as SyncPolicy)
      },
      stateRepo: {
        findByKey: jest.fn().mockResolvedValue({ cursor_value: JSON.stringify({ lastEndDate: '2020-01-31T00:00:00Z' }) } as SyncState),
        upsert: jest.fn().mockResolvedValue(undefined)
      },
      leaseRepo: {
        tryAcquire: jest.fn().mockResolvedValue({ acquired: true }),
        renew: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(undefined)
      },
      classifier: {
        classify: jest.fn().mockReturnValue(OrderLifecycleStage.MUTABLE),
        isMutable: jest.fn().mockReturnValue(true),
        isBilledLogisticsReady: jest.fn().mockReturnValue(false),
        isCancelled: jest.fn().mockReturnValue(false),
      },
      logger: new NullLogger(),
      clock: { now: jest.fn().mockReturnValue(new Date('2020-05-01T00:00:00Z').getTime()) }, // Simulated "today"
      workerId: '123e4567-e89b-12d3-a456-426614174000'
    };
  });

  it('runs multiple windows sequentially and stops when max windows is reached', async () => {
    // Advance the mock state returned so the orchestrator reads the updated cursor for the next window
    let windowIndex = 0;
    const cursors = [
      '2020-01-31T00:00:00Z',
      '2020-03-01T00:00:00.000Z',
      '2020-03-31T00:00:00.000Z'
    ];
    deps.stateRepo.findByKey.mockImplementation(() => {
      return Promise.resolve({ cursor_value: JSON.stringify({ lastEndDate: cursors[windowIndex] }) } as SyncState);
    });
    deps.stateRepo.upsert.mockImplementation(() => {
      windowIndex++;
      return Promise.resolve();
    });

    const orchestrator = new BackfillOrchestrator(deps);
    const result = await orchestrator.run(2); // Max 2 windows

    expect(result.windowsProcessed).toBe(2);
    expect(result.success).toBe(true);
    expect(deps.stateRepo.upsert).toHaveBeenCalledTimes(2);
    expect(deps.leaseRepo.tryAcquire).toHaveBeenCalledTimes(1);
    expect(deps.leaseRepo.release).toHaveBeenCalledTimes(1);
  });

  it('stops immediately on failure', async () => {
    // Force OrdersSync to fail on the first execution
    deps.ordersProvider.getOrders.mockRejectedValue(new Error('API Error'));

    const orchestrator = new BackfillOrchestrator(deps);
    const result = await orchestrator.run(5);

    expect(result.windowsProcessed).toBe(0);
    expect(result.success).toBe(false);
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
    expect(deps.leaseRepo.release).toHaveBeenCalledTimes(1);
  });

  it('stops processing if it reaches today', async () => {
    // Cursor is already equal to "today"
    deps.stateRepo.findByKey.mockResolvedValue({ cursor_value: JSON.stringify({ lastEndDate: '2020-05-01T00:00:00Z' }) } as SyncState);
    
    const orchestrator = new BackfillOrchestrator(deps);
    const result = await orchestrator.run(5);

    expect(result.windowsProcessed).toBe(0); // Didn't even run one because it's already today
    expect(result.success).toBe(true);
  });

  it('fails if lease cannot be acquired', async () => {
    deps.leaseRepo.tryAcquire.mockResolvedValue({ acquired: false });
    
    const orchestrator = new BackfillOrchestrator(deps);
    const result = await orchestrator.run(5);

    expect(result.windowsProcessed).toBe(0);
    expect(result.success).toBe(false);
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
  });
});
