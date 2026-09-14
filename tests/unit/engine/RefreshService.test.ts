import {
  RefreshService,
  RefreshDeps,
} from '../../../src/engine/RefreshService';
import {
  ICampaignsRepository,
  ILeadsRepository,
  IProductsRepository,
} from '../../../src/contracts/repositories';
import {
  IOrderDetailProvider,
  ITrackingProvider,
  ICampaignsProvider,
  ILeadsProvider,
  IProductsProvider,
  IVoucherDetailProvider,
} from '../../../src/contracts/providers';
import { NullLogger } from '../../../src/observability/Logger';
import { OrderStateInput, TrackingCandidate, TrackingStateInput } from '../../../src/contracts/types';
import { IOrderClassifier, ITrackingClassifier, OrderLifecycleStage, TrackingLifecycleStage } from '../../../src/engine/Classifiers';

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

function buildDeps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    detailProvider: { getOrderDetail: jest.fn().mockResolvedValue({}) } as unknown as IOrderDetailProvider,
    trackingProvider: { getTracking: jest.fn().mockResolvedValue([]) } as unknown as ITrackingProvider,
    campaignsProvider: { getCampaigns: jest.fn().mockResolvedValue([]) } as unknown as ICampaignsProvider,
    leadsProvider: { getLeads: jest.fn().mockResolvedValue([]), getRedeemedLeads: jest.fn().mockResolvedValue([]) } as unknown as ILeadsProvider,
    productsProvider: { getProducts: jest.fn().mockResolvedValue([]) } as unknown as IProductsProvider,
    voucherDetailProvider: { getVoucherDetail: jest.fn().mockResolvedValue({}) } as unknown as IVoucherDetailProvider,
    detailsRepo: { upsert: jest.fn().mockResolvedValue(undefined), exists: jest.fn().mockResolvedValue(false) } as any,
    trackingRepo: { upsert: jest.fn().mockResolvedValue(undefined), findTrackingCandidatesForOrder: jest.fn().mockResolvedValue(null) } as any,
    campaignsRepo: { upsertMany: jest.fn().mockResolvedValue(undefined) } as unknown as ICampaignsRepository,
    leadsRepo: { upsertMany: jest.fn().mockResolvedValue(undefined), upsertRedeemedMany: jest.fn().mockResolvedValue(undefined) } as unknown as ILeadsRepository,
    productsRepo: { upsertMany: jest.fn().mockResolvedValue(undefined) } as unknown as IProductsRepository,
    orderClassifier: new TestOrderClassifier(),
    trackingClassifier: new TestTrackingClassifier(),
    logger: new NullLogger(),
    ...overrides,
  };
}

describe('RefreshService', () => {
  describe('refreshTracking', () => {
    it('should NOT call provider if order is mutable', async () => {
      const deps = buildDeps();
      const candidate: TrackingCandidate = { order_id: '1', order_number: '123', nf_number: 'NF1', raw_order_status: 'TEST_MUTABLE', raw_order_codsit: null, tracking_state: null };
      (deps.trackingRepo.findTrackingCandidatesForOrder as jest.Mock).mockResolvedValue([candidate]);
      const service = new RefreshService(deps);
      
      const result = await service.refreshTracking('123');
      
      expect(result.success).toBe(false);
      expect(result.errors[0] || "").toContain('mutable');
      expect(deps.trackingProvider.getTracking).not.toHaveBeenCalled();
    });

    it('should NOT call provider if order is cancelled', async () => {
      const deps = buildDeps();
      const candidate: TrackingCandidate = { order_id: '1', order_number: '123', nf_number: 'NF1', raw_order_status: 'TEST_CANCELLED', raw_order_codsit: null, tracking_state: null };
      (deps.trackingRepo.findTrackingCandidatesForOrder as jest.Mock).mockResolvedValue([candidate]);
      const service = new RefreshService(deps);
      
      const result = await service.refreshTracking('123');
      
      expect(result.success).toBe(false);
      expect(result.errors[0] || "").toContain('cancelled');
      expect(deps.trackingProvider.getTracking).not.toHaveBeenCalled();
    });

    it('should NOT call provider if tracking is terminal', async () => {
      const deps = buildDeps();
      const tc = deps.trackingClassifier as TestTrackingClassifier;
      tc.terminalStatuses.add('TERMINAL_STATUS');

      const candidate: TrackingCandidate = { order_id: '1', order_number: '123', nf_number: 'NF1', raw_order_status: 'TEST_BILLED', raw_order_codsit: null, tracking_state: { status_entrega: 'TERMINAL_STATUS' } as any };
      (deps.trackingRepo.findTrackingCandidatesForOrder as jest.Mock).mockResolvedValue([candidate]);
      const service = new RefreshService(deps);
      
      const result = await service.refreshTracking('123');
      
      expect(result.success).toBe(false);
      expect(result.errors[0] || "").toContain('terminal');
      expect(deps.trackingProvider.getTracking).not.toHaveBeenCalled();
    });

    it('should NOT call provider if nf_number is missing', async () => {
      const deps = buildDeps();
      const candidate: TrackingCandidate = { order_id: '1', order_number: '123', nf_number: '', raw_order_status: 'TEST_BILLED', raw_order_codsit: null, tracking_state: null };
      (deps.trackingRepo.findTrackingCandidatesForOrder as jest.Mock).mockResolvedValue([candidate]);
      const service = new RefreshService(deps);
      
      const result = await service.refreshTracking('123');
      
      expect(result.success).toBe(false);
      expect(result.errors[0] || "").toContain('No NF');
      expect(deps.trackingProvider.getTracking).not.toHaveBeenCalled();
    });

    it('should call provider if billed, has NF, and not terminal', async () => {
      const deps = buildDeps();
      const candidate: TrackingCandidate = { order_id: '1', order_number: '123', nf_number: 'NF1', raw_order_status: 'TEST_BILLED', raw_order_codsit: null, tracking_state: { status_entrega: 'ACTIVE' } as any };
      (deps.trackingRepo.findTrackingCandidatesForOrder as jest.Mock).mockResolvedValue([candidate]);
      const service = new RefreshService(deps);
      
      const result = await service.refreshTracking('123');
      
      expect(result.success).toBe(true);
      expect(deps.trackingProvider.getTracking).toHaveBeenCalledWith('NF1');
    });
  });
});
