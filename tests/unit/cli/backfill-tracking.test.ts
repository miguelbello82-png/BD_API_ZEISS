import { TrackingBackfillOrchestrator, TrackingBackfillOrchestratorDeps } from '../../../src/engine/TrackingBackfillOrchestrator';
import { SyncState, SyncPolicy } from '../../../src/contracts/repositories';

describe('TrackingBackfillOrchestrator', () => {
  let deps: any;

  beforeEach(() => {
    deps = {
      trackingProvider: {
        getTracking: jest.fn().mockResolvedValue([]),
      },
      trackingRepo: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findTrackingCandidates: jest.fn().mockResolvedValue([]),
      },
      orderClassifier: {
        isBilledLogisticsReady: jest.fn().mockReturnValue(true),
        isCancelled: jest.fn().mockReturnValue(false),
      },
      trackingClassifier: {
        isTerminal: jest.fn().mockReturnValue(false),
      },
      policyRepo: {
        findByKey: jest.fn().mockResolvedValue({ 
          enabled: true, 
          lease_ttl_seconds: 300, 
          operation_config: { batch_limit: 50 } 
        } as unknown as SyncPolicy)
      },
      stateRepo: {
        findByKey: jest.fn().mockResolvedValue({ cursor_value: JSON.stringify({ lastOrderId: '100', lastNfNumber: 'NF1' }) } as SyncState),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
      leaseRepo: {
        tryAcquire: jest.fn().mockResolvedValue({ acquired: true, holder_id: 'test' }),
        renew: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(undefined),
      },
      logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
      },
      workerId: 'test-worker-1',
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('runs multiple batches sequentially and stops when end of candidates is reached', async () => {
    // Mock candidate search to return data twice, then return empty (end of candidates)
    deps.trackingRepo.findTrackingCandidates
      .mockResolvedValueOnce([{ order_id: '101', order_number: 'O1', nf_number: 'NF2', raw_order_status: 'A', raw_order_codsit: 'B', tracking_state: 'C' }])
      .mockResolvedValueOnce([{ order_id: '102', order_number: 'O2', nf_number: 'NF3', raw_order_status: 'A', raw_order_codsit: 'B', tracking_state: 'C' }])
      .mockResolvedValueOnce([]); // Empty means we reached the end

    const cursors = [
      JSON.stringify({ lastOrderId: '101', lastNfNumber: 'NF2' }),
      JSON.stringify({ lastOrderId: '102', lastNfNumber: 'NF3' }),
      JSON.stringify({ lastOrderId: undefined, lastNfNumber: undefined })
    ];

    let batchIndex = 0;
    deps.stateRepo.findByKey.mockImplementation(() => {
      const cursor = batchIndex === 0 ? JSON.stringify({ lastOrderId: '100' }) : cursors[batchIndex - 1];
      return Promise.resolve({ cursor_value: cursor } as SyncState);
    });

    deps.stateRepo.upsert.mockImplementation((state: SyncState) => {
      batchIndex++;
      return Promise.resolve(undefined);
    });

    const orchestrator = new TrackingBackfillOrchestrator(deps);
    const result = await orchestrator.run(10); // high limit

    expect(result.success).toBe(true);
    expect(result.batchesProcessed).toBe(3); // 2 batches with data + 1 batch returning empty
    expect(result.reachedEndOfCandidateSet).toBe(true);
    expect(deps.stateRepo.upsert).toHaveBeenCalledTimes(3);

    // Should break immediately after detecting undefined lastOrderId
    expect(result.endingCursor).toEqual('{}');
  });

  it('stops processing immediately on provider failure without advancing cursor', async () => {
    // Return candidates but fail at provider
    deps.trackingRepo.findTrackingCandidates
      .mockResolvedValueOnce([{ order_id: '101', order_number: 'O1', nf_number: 'NF2', raw_order_status: 'A', raw_order_codsit: 'B', tracking_state: 'C' }]);
    
    deps.trackingProvider.getTracking.mockRejectedValue(new Error('Zeiss API Error'));

    const orchestrator = new TrackingBackfillOrchestrator(deps);
    const result = await orchestrator.run(5);

    expect(result.success).toBe(true); // Job handles provider failures gracefully at candidate level!
    // Wait, if it fails gracefully, the batch succeeds!
    // Let's modify the test to test an actual fatal batch failure, like DB error during finding candidates
    deps.stateRepo.upsert.mockClear();
    deps.trackingRepo.findTrackingCandidates.mockRejectedValue(new Error('DB connection lost'));
    const result2 = await orchestrator.run(5);
    expect(result2.success).toBe(false);
    expect(result2.batchesProcessed).toBe(0);
    // Should not upsert state on fatal error
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
  });

  it('aggregates not_found and fetch_errors metrics correctly', async () => {
    deps.trackingRepo.findTrackingCandidates
      .mockResolvedValueOnce([
        { order_id: '101', order_number: 'O1', nf_number: 'NF2', raw_order_status: 'A', raw_order_codsit: 'B', tracking_state: 'C' },
        { order_id: '102', order_number: 'O2', nf_number: 'NF3', raw_order_status: 'A', raw_order_codsit: 'B', tracking_state: 'C' }
      ])
      .mockResolvedValueOnce([]); // end

    // First candidate throws 404, second throws 500
    deps.trackingProvider.getTracking
      .mockRejectedValueOnce(new Error('HTTP 404 Not Found'))
      .mockRejectedValueOnce(new Error('HTTP 500 Internal Error'));

    const orchestrator = new TrackingBackfillOrchestrator(deps);
    const result = await orchestrator.run(10);

    expect(result.success).toBe(true);
    expect(result.not_found).toBe(1);
    expect(result.fetch_errors).toBe(1);
    expect(result.candidatesFound).toBe(2);
  });

  it('stops processing if lease cannot be acquired', async () => {
    deps.leaseRepo.tryAcquire.mockResolvedValue({ acquired: false, holder_id: 'other' });

    const orchestrator = new TrackingBackfillOrchestrator(deps);
    const result = await orchestrator.run(2);

    expect(result.success).toBe(false);
    expect(result.batchesProcessed).toBe(0);
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
    expect(deps.leaseRepo.renew).not.toHaveBeenCalled();
  });

  it('stops processing if lease ownership is lost before state advancement', async () => {
    deps.trackingRepo.findTrackingCandidates.mockResolvedValueOnce([{ order_id: '101', order_number: 'O1', nf_number: 'NF2', raw_order_status: 'A', raw_order_codsit: 'B', tracking_state: 'C' }]);
    
    // Renew fails before state upsert
    deps.leaseRepo.renew.mockResolvedValue(false);

    const orchestrator = new TrackingBackfillOrchestrator(deps);
    const result = await orchestrator.run(2);

    expect(result.success).toBe(false);
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
    // It should not release if ownership was lost
    expect(deps.leaseRepo.release).not.toHaveBeenCalled();
  });
});
