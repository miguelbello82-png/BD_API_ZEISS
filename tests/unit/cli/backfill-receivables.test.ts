import { ReceivablesBackfillOrchestrator } from '../../../src/engine/ReceivablesBackfillOrchestrator';
import { NullLogger } from '../../../src/observability/Logger';
import { SyncPolicy, SyncState } from '../../../src/contracts/repositories';

describe('ReceivablesBackfillOrchestrator', () => {
  let deps: any;

  beforeEach(() => {
    deps = {
      provider: { getReceivables: jest.fn().mockResolvedValue([]) },
      repo: {
        upsertMany: jest.fn().mockResolvedValue([]),
      },
      policyRepo: {
        findByKey: jest.fn().mockResolvedValue({ enabled: true, lease_ttl_seconds: 300, operation_config: { maxRangeDays: 30, status: 'all', pedido: '0' } } as unknown as SyncPolicy)
      },
      stateRepo: {
        findByKey: jest.fn().mockResolvedValue({ cursor_value: JSON.stringify({ lastEndDate: '2026-01-31' }) } as SyncState),
        upsert: jest.fn().mockResolvedValue(undefined)
      },
      leaseRepo: {
        tryAcquire: jest.fn().mockResolvedValue({ acquired: true }),
        renew: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(undefined)
      },
      logger: new NullLogger(),
      clock: { now: jest.fn().mockReturnValue(new Date('2026-05-01').getTime()) }, // Simulated "today"
      workerId: '123e4567-e89b-12d3-a456-426614174000'
    };
  });

  it('runs multiple windows sequentially and stops when max windows is reached', async () => {
    let windowIndex = 0;
    const cursors = [
      '2026-01-31',
      '2026-03-02',
      '2026-04-01'
    ];

    deps.stateRepo.findByKey.mockImplementation(() => {
      const cursor = windowIndex === 0 ? cursors[0] : (windowIndex === 1 ? cursors[1] : cursors[2]);
      return Promise.resolve({ cursor_value: JSON.stringify({ lastEndDate: cursor }) } as SyncState);
    });

    deps.stateRepo.upsert.mockImplementation((state: SyncState) => {
      const parsed = JSON.parse(state.cursor_value!);
      if (parsed.lastEndDate === '2026-03-02' && windowIndex === 0) {
        windowIndex = 1;
      } else if (parsed.lastEndDate === '2026-04-01' && windowIndex === 1) {
        windowIndex = 2;
      }
      return Promise.resolve(undefined);
    });

    const orchestrator = new ReceivablesBackfillOrchestrator(deps);
    const result = await orchestrator.run(2);

    expect(result.success).toBe(true);
    expect(result.windowsProcessed).toBe(2);
    expect(result.finalCursor).toContain('2026-04-01');
    expect(deps.stateRepo.upsert).toHaveBeenCalledTimes(2);
    expect(deps.leaseRepo.release).toHaveBeenCalledTimes(1);
  });

  it('stops processing and returns immediately if today is reached', async () => {
    // Current state is right at "today" (2026-05-01)
    deps.stateRepo.findByKey.mockResolvedValue({ cursor_value: JSON.stringify({ lastEndDate: '2026-05-01' }) } as SyncState);

    const orchestrator = new ReceivablesBackfillOrchestrator(deps);
    const result = await orchestrator.run(10);

    // It stops at today, no windows processed.
    expect(result.success).toBe(true); // Loop wasn't aborted due to failure
    expect(result.windowsProcessed).toBe(0);
    expect(deps.provider.getReceivables).not.toHaveBeenCalled();
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
    expect(deps.leaseRepo.release).toHaveBeenCalled();
  });

  it('stops processing immediately on provider failure without advancing cursor', async () => {
    // Force a failure in the provider
    deps.provider.getReceivables.mockRejectedValue(new Error('Zeiss API Error'));

    const orchestrator = new ReceivablesBackfillOrchestrator(deps);
    const result = await orchestrator.run(5);

    expect(result.success).toBe(false);
    expect(result.windowsProcessed).toBe(0);
    expect(result.totalErrors).toBe(0); // Job returns no metrics on fatal provider failure
    
    // No state update should occur for the failed window
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
  });

  it('stops processing if lease cannot be acquired', async () => {
    deps.leaseRepo.tryAcquire.mockResolvedValue({ acquired: false });

    const orchestrator = new ReceivablesBackfillOrchestrator(deps);
    const result = await orchestrator.run(10);

    expect(result.success).toBe(false);
    expect(result.windowsProcessed).toBe(0);
    expect(deps.provider.getReceivables).not.toHaveBeenCalled();
  });

  it('stops processing if lease ownership is lost before state advancement', async () => {
    // Renew fails
    deps.leaseRepo.renew.mockResolvedValue(false);

    const orchestrator = new ReceivablesBackfillOrchestrator(deps);
    const result = await orchestrator.run(5);

    expect(result.success).toBe(false);
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
    // It should not release if ownership was lost
    expect(deps.leaseRepo.release).not.toHaveBeenCalled();
  });
});
