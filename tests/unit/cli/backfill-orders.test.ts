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

  it('persists cursor when only ORD-002 hydration fails (partial success)', async () => {
    // Force OrdersSync to succeed but return hydration_errors
    deps.ordersProvider.getOrders.mockResolvedValue([{ 'nr-pedido': '101' }]);
    deps.detailProvider.getOrderDetail.mockRejectedValue(new Error('Internal Server Error 500'));
    deps.ordersRepo.findOrdersWithoutDetail.mockResolvedValue([{ order_id: '1', order_number: '1' }]);
    
    // Setup state
    deps.stateRepo.findByKey.mockResolvedValue({ cursor_value: JSON.stringify({ lastEndDate: '2020-01-31T00:00:00Z' }) } as SyncState);

    const orchestrator = new BackfillOrchestrator(deps);
    const result = await orchestrator.run(1); // just run 1 window for this test

    expect(result.windowsProcessed).toBe(1);
    expect(result.success).toBe(true);
    expect(deps.stateRepo.upsert).toHaveBeenCalledTimes(1);
    expect(result.totalErrors).toBe(1); // Reflects hydration error
  });

  it('does not advance cursor if ORD-001 fails', async () => {
    deps.ordersProvider.getOrders.mockRejectedValue(new Error('API Timeout'));
    
    deps.stateRepo.findByKey.mockResolvedValue({ cursor_value: JSON.stringify({ lastEndDate: '2020-01-31T00:00:00Z' }) } as SyncState);

    const orchestrator = new BackfillOrchestrator(deps);
    const result = await orchestrator.run(1);

    expect(result.windowsProcessed).toBe(0);
    expect(result.success).toBe(false);
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
  });

  it('does not advance cursor if lease is lost before update', async () => {
    // Make renew fail when it tries to renew right before state advancement
    deps.leaseRepo.renew.mockResolvedValue(false);
    
    deps.stateRepo.findByKey.mockResolvedValue({ cursor_value: JSON.stringify({ lastEndDate: '2020-01-31T00:00:00Z' }) } as SyncState);

    const orchestrator = new BackfillOrchestrator(deps);
    const result = await orchestrator.run(1);

    expect(result.windowsProcessed).toBe(0);
    expect(result.success).toBe(false); // Loop success becomes false
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
  });

  it('accumulates metrics correctly across multiple windows', async () => {
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

    deps.ordersProvider.getOrders.mockResolvedValue([{ 'nr-pedido': '101' }]);
    deps.ordersRepo.findOrdersWithoutDetail.mockResolvedValue([{ order_id: '1', order_number: '101', raw_status: 'Pendente' }]);
    deps.detailProvider.getOrderDetail.mockResolvedValue({ situacao: 'ok' });

    const orchestrator = new BackfillOrchestrator(deps);
    const result = await orchestrator.run(2);

    expect(result.windowsProcessed).toBe(2);
    expect(result.totalDiscovered).toBe(2); // 1 per window
    expect(result.totalHydrated).toBe(2); // 1 per window
    expect(result.totalErrors).toBe(0);
  });
});
