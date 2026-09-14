import { TrackingCandidate, OrderStateInput, DateSlice, TrackingStateInput } from '../../../src/contracts/types';
import {
  BootstrapService,
  BootstrapDeps,
  OrdersBootstrapConfig,
  TrackingBootstrapConfig,
} from '../../../src/engine/BootstrapService';
import {
  OrderLifecycleStage,
  IOrderClassifier,
  ITrackingClassifier,
  TrackingLifecycleStage,
} from '../../../src/engine/Classifiers';
import {
  IOrdersRepository,
  IOrderDetailsRepository,
  ITrackingRepository,
  ISyncStateRepository,
} from '../../../src/contracts/repositories';
import {
  IOrdersListProvider,
  IOrderDetailProvider,
  ITrackingProvider,
} from '../../../src/contracts/providers';
import { NullLogger } from '../../../src/observability/Logger';

// ============================================================
// Test Doubles
// ============================================================

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

function buildDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    ordersProvider: { getOrders: jest.fn().mockResolvedValue([]) },
    detailProvider: { getOrderDetail: jest.fn().mockResolvedValue({}) },
    trackingProvider: { getTracking: jest.fn().mockResolvedValue([]) },
    ordersRepo: {
      upsertMany: jest.fn().mockResolvedValue([]),
      findOrdersWithoutDetail: jest.fn().mockResolvedValue([]),
      findActiveOrders: jest.fn().mockResolvedValue([]),
    },
    detailsRepo: {
      upsert: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
    },
    trackingRepo: {
      upsert: jest.fn().mockResolvedValue(undefined),
      findTrackingCandidatesForOrder: jest.fn().mockResolvedValue([]),
      findTrackingCandidatesByDate: jest.fn().mockResolvedValue([]),
      findTrackingCandidates: jest.fn().mockResolvedValue([]),
    },
    syncStateRepo: {
      findByKey: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    orderClassifier: new TestOrderClassifier(),
    trackingClassifier: new TestTrackingClassifier(),
    logger: new NullLogger(),
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('BootstrapService', () => {
  describe('Orders Bootstrap', () => {
    it('should resume from cursor and stop on first failure', async () => {
      const deps = buildDeps();
      const config: OrdersBootstrapConfig = {
        slices: [
          { startDate: '2026-01-01', endDate: '2026-01-10' }, // A
          { startDate: '2026-01-11', endDate: '2026-01-20' }, // B
          { startDate: '2026-01-21', endDate: '2026-01-30' }, // C
        ],
        status: 'TODOS',
      };

      // Execution 1: A -> Success, B -> Failure, C -> Doesn't execute
      (deps.ordersProvider.getOrders as jest.Mock)
        .mockResolvedValueOnce([{ 'nr-pedido': 'A1' }]) // A
        .mockResolvedValueOnce([{ 'nr-pedido': 'B1' }]); // B
        
      (deps.detailProvider.getOrderDetail as jest.Mock)
        .mockResolvedValueOnce({ situacao: 'ok' }) // A success
        .mockRejectedValueOnce(new Error('Hydration failure')); // B fails

      const bootstrap1 = new BootstrapService(deps);
      const res1 = await bootstrap1.bootstrapOrders(config);

      expect(deps.ordersProvider.getOrders).toHaveBeenCalledTimes(2);
      expect(deps.syncStateRepo.upsert).toHaveBeenCalledTimes(1); // Only upserts cursor for A
      const cursorCall = (deps.syncStateRepo.upsert as jest.Mock).mock.calls[0][0];
      const cursorState = JSON.parse(cursorCall.cursor_value);
      expect(cursorState.lastSlice.startDate).toBe('2026-01-01'); // Stopped at A

      // Reset mocks for Execution 2
      jest.clearAllMocks();
      
      // Setup DB to return cursor at A
      (deps.syncStateRepo.findByKey as jest.Mock).mockResolvedValue({
        cursor_value: JSON.stringify({ lastSlice: { startDate: '2026-01-01', endDate: '2026-01-10' } })
      });

      // Execution 2: B -> Success, C -> Success
      (deps.ordersProvider.getOrders as jest.Mock)
        .mockResolvedValueOnce([{ 'nr-pedido': 'B1' }]) // B
        .mockResolvedValueOnce([{ 'nr-pedido': 'C1' }]); // C
        
      (deps.detailProvider.getOrderDetail as jest.Mock)
        .mockResolvedValue({ situacao: 'ok' }); // All success now

      const bootstrap2 = new BootstrapService(deps);
      const res2 = await bootstrap2.bootstrapOrders(config);

      expect(deps.ordersProvider.getOrders).toHaveBeenCalledTimes(2); // Queries B and C
      expect(deps.syncStateRepo.upsert).toHaveBeenCalledTimes(2); // Upserts cursor for B, then C
      
      const lastCursorCall = (deps.syncStateRepo.upsert as jest.Mock).mock.calls[1][0];
      const lastCursorState = JSON.parse(lastCursorCall.cursor_value);
      expect(lastCursorState.lastSlice.startDate).toBe('2026-01-21'); // Reached C
    });
  });

  describe('Tracking Bootstrap', () => {
    it('should resume from cursor and stop on first failure', async () => {
      const deps = buildDeps();
      const config: TrackingBootstrapConfig = {
        prioritySlices: [
          { startDate: '2026-01-01', endDate: '2026-01-10' }, // A
          { startDate: '2026-01-11', endDate: '2026-01-20' }, // B
          { startDate: '2026-01-21', endDate: '2026-01-30' }, // C
        ],
        historicSlices: [],
      };

      const cA: TrackingCandidate = { order_id: 'o1', order_number: 'A1', nf_number: 'NF1', raw_order_status: 'TEST_BILLED', raw_order_codsit: null, tracking_state: null };
      const cB: TrackingCandidate = { order_id: 'o2', order_number: 'B1', nf_number: 'NF2', raw_order_status: 'TEST_BILLED', raw_order_codsit: null, tracking_state: null };
      const cC: TrackingCandidate = { order_id: 'o3', order_number: 'C1', nf_number: 'NF3', raw_order_status: 'TEST_BILLED', raw_order_codsit: null, tracking_state: null };

      // Execution 1: A -> Success, B -> Failure, C -> Doesn't execute
      (deps.trackingRepo.findTrackingCandidatesByDate as jest.Mock)
        .mockResolvedValueOnce([cA]) // A
        .mockResolvedValueOnce([cB]); // B
        
      (deps.trackingProvider.getTracking as jest.Mock)
        .mockResolvedValueOnce([]) // A success
        .mockRejectedValueOnce(new Error('TRK failure')); // B fails

      const bootstrap1 = new BootstrapService(deps);
      const res1 = await bootstrap1.bootstrapTracking(config);

      expect(deps.trackingRepo.findTrackingCandidatesByDate).toHaveBeenCalledTimes(2);
      expect(deps.syncStateRepo.upsert).toHaveBeenCalledTimes(1); // Only upserts cursor for A
      
      const cursorCall = (deps.syncStateRepo.upsert as jest.Mock).mock.calls[0][0];
      const cursorState = JSON.parse(cursorCall.cursor_value);
      expect(cursorState.lastProcessedSlice.startDate).toBe('2026-01-01'); // Stopped at A

      // Reset mocks for Execution 2
      jest.clearAllMocks();
      
      // Setup DB to return cursor at A
      (deps.syncStateRepo.findByKey as jest.Mock).mockResolvedValue({
        cursor_value: JSON.stringify({ lastProcessedSlice: { startDate: '2026-01-01', endDate: '2026-01-10' } })
      });

      // Execution 2: B -> Success, C -> Success
      (deps.trackingRepo.findTrackingCandidatesByDate as jest.Mock)
        .mockResolvedValueOnce([cB]) // B
        .mockResolvedValueOnce([cC]); // C
        
      (deps.trackingProvider.getTracking as jest.Mock)
        .mockResolvedValue([]); // All success now

      const bootstrap2 = new BootstrapService(deps);
      const res2 = await bootstrap2.bootstrapTracking(config);

      expect(deps.trackingRepo.findTrackingCandidatesByDate).toHaveBeenCalledTimes(2); // Queries B and C
      expect(deps.syncStateRepo.upsert).toHaveBeenCalledTimes(2); // Upserts cursor for B, then C
      
      const lastCursorCall = (deps.syncStateRepo.upsert as jest.Mock).mock.calls[1][0];
      const lastCursorState = JSON.parse(lastCursorCall.cursor_value);
      expect(lastCursorState.lastProcessedSlice.startDate).toBe('2026-01-21'); // Reached C
    });
  });
});
