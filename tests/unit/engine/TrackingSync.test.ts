import { TrackingCandidate, OrderStateInput, TrackingStateInput } from '../../../src/contracts/types';
import { TrackingSync, TrackingSyncDeps } from '../../../src/engine/TrackingSync';
import { ITrackingRepository } from '../../../src/contracts/repositories';
import { ITrackingProvider } from '../../../src/contracts/providers';
import { NullLogger } from '../../../src/observability/Logger';
import { IOrderClassifier, ITrackingClassifier, OrderLifecycleStage, TrackingLifecycleStage } from '../../../src/engine/Classifiers';
import { JobContext } from '../../../src/engine/JobRegistry';

class TestOrderClassifier implements IOrderClassifier {
  public billedStatuses: Set<string>;
  public cancelledStatuses: Set<string>;
  
  constructor(billedStatuses: string[] = ['TEST_BILLED'], cancelledStatuses: string[] = ['TEST_CANCELLED']) {
    this.billedStatuses = new Set(billedStatuses);
    this.cancelledStatuses = new Set(cancelledStatuses);
  }
  
  classify(state: OrderStateInput): OrderLifecycleStage {
    if (!state || !state.status) return OrderLifecycleStage.UNKNOWN;
    if (this.cancelledStatuses.has(state.status)) return OrderLifecycleStage.CANCELLED;
    if (this.billedStatuses.has(state.status)) return OrderLifecycleStage.BILLED_LOGISTICS_READY;
    return OrderLifecycleStage.MUTABLE;
  }
  isMutable(state: OrderStateInput): boolean {
    return this.classify(state) === OrderLifecycleStage.MUTABLE;
  }
  isBilledLogisticsReady(state: OrderStateInput): boolean {
    return this.classify(state) === OrderLifecycleStage.BILLED_LOGISTICS_READY;
  }
  isCancelled(state: OrderStateInput): boolean {
    return this.classify(state) === OrderLifecycleStage.CANCELLED;
  }
}

class TestTrackingClassifier implements ITrackingClassifier {
  public terminalStatuses = new Set<string>();
  classify(state: TrackingStateInput | null): TrackingLifecycleStage {
    if (!state || !state.status_entrega) return TrackingLifecycleStage.UNKNOWN;
    if (this.terminalStatuses.has(state.status_entrega)) return TrackingLifecycleStage.TERMINAL;
    return TrackingLifecycleStage.ACTIVE;
  }
  isTerminal(state: TrackingStateInput | null): boolean {
    return this.classify(state) === TrackingLifecycleStage.TERMINAL;
  }
}

function buildDeps(): TrackingSyncDeps {
  return {
    trackingProvider: { getTracking: jest.fn().mockResolvedValue([]) },
    trackingRepo: {
      findTrackingCandidatesForOrder: jest.fn().mockResolvedValue([]),
      findTrackingCandidatesByDate: jest.fn().mockResolvedValue([]),
      findTrackingCandidates: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    orderClassifier: new TestOrderClassifier(),
    trackingClassifier: new TestTrackingClassifier(),
    logger: new NullLogger(),
  };
}

describe('TrackingSync Engine', () => {
  let deps: TrackingSyncDeps;
  let context: JobContext;

  beforeEach(() => {
    deps = buildDeps();
    context = {
      provider: 'zeiss',
      domain: 'tracking',
      operation: 'sync',
      abortSignal: new AbortController().signal,
      policy: {
        provider: 'zeiss', domain: 'tracking', operation: 'sync', enabled: true,
        interval_seconds: 60, timeout_seconds: 60, lease_ttl_seconds: 120, max_retries: 0, retry_delay_seconds: 0,
        lookback_seconds: null,
        operation_config: { batch_limit: 10 }
      },
      lastSyncState: null
    };
  });

  it('should only process eligible candidates', async () => {
    const tc = deps.trackingClassifier as TestTrackingClassifier;
    tc.terminalStatuses.add('DELIVERED');

    const candidates: TrackingCandidate[] = [
      { order_id: 'o1', order_number: '101', nf_number: 'NF101', raw_order_status: 'TEST_MUTABLE', raw_order_codsit: null, tracking_state: { status_entrega: 'PENDING' } as any },
      { order_id: 'o2', order_number: '102', nf_number: 'NF102', raw_order_status: 'TEST_BILLED', raw_order_codsit: null, tracking_state: { status_entrega: 'PENDING' } as any },
      { order_id: 'o3', order_number: '103', nf_number: 'NF103', raw_order_status: 'TEST_BILLED', raw_order_codsit: null, tracking_state: { status_entrega: 'DELIVERED' } as any },
      { order_id: 'o4', order_number: '104', nf_number: 'NF104', raw_order_status: 'TEST_CANCELLED', raw_order_codsit: null, tracking_state: { status_entrega: 'PENDING' } as any },
    ];
    (deps.trackingRepo.findTrackingCandidates as jest.Mock).mockResolvedValue(candidates);

    const engine = new TrackingSync(deps);
    const result = await engine.execute(context);

    // Only 'o2' is billed, not cancelled, and not terminal tracking
    expect(result.metrics?.candidatesFound).toBe(1);
    expect(result.metrics?.updated).toBe(1);
    expect(deps.trackingProvider.getTracking).toHaveBeenCalledWith('NF102', context.abortSignal);
  });

  it('should correctly handle and record provider errors', async () => {
    const candidates: TrackingCandidate[] = [
      { order_id: 'o1', order_number: '101', nf_number: 'NF101', raw_order_status: 'TEST_BILLED', raw_order_codsit: null, tracking_state: null },
    ];
    (deps.trackingRepo.findTrackingCandidates as jest.Mock).mockResolvedValue(candidates);
    (deps.trackingProvider.getTracking as jest.Mock).mockRejectedValue(new Error('Provider Error'));

    const engine = new TrackingSync(deps);
    const result = await engine.execute(context);

    expect(result.metrics?.updated).toBe(0);
    expect(result.metrics?.errors).toBe(1);
    expect(result.success).toBe(false);
  });
});
