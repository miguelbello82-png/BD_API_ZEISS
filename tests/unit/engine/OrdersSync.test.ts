import { OrderRecord, OrderCandidate, OrderStateInput } from '../../../src/contracts/types';
import { OrdersSync, OrdersSyncDeps } from '../../../src/engine/OrdersSync';
import {
  IOrdersRepository,
  IOrderDetailsRepository,
  SyncPolicy
} from '../../../src/contracts/repositories';
import {
  IOrdersListProvider,
  IOrderDetailProvider,
} from '../../../src/contracts/providers';
import { NullLogger } from '../../../src/observability/Logger';
import { IOrderClassifier, OrderLifecycleStage } from '../../../src/engine/Classifiers';
import { IClock } from '../../../src/utils/Clock';
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

function buildDeps(): OrdersSyncDeps {
  return {
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
    classifier: new TestOrderClassifier(),
    logger: new NullLogger(),
    clock: { now: jest.fn().mockReturnValue(new Date('2026-08-21T00:00:00Z').getTime()) }
  };
}

describe('OrdersSync Engine', () => {
  let deps: OrdersSyncDeps;
  let context: JobContext;

  beforeEach(() => {
    deps = buildDeps();
    context = {
      provider: 'zeiss',
      domain: 'orders',
      operation: 'discovery',
      abortSignal: new AbortController().signal,
      policy: {
        provider: 'zeiss', domain: 'orders', operation: 'discovery', enabled: true,
        interval_seconds: 60, timeout_seconds: 60, lease_ttl_seconds: 120, max_retries: 0, retry_delay_seconds: 0,
        lookback_seconds: null,
        operation_config: { maxRangeDays: 30, statusFilter: 'TODOS' }
      },
      lastSyncState: {
        provider: 'zeiss', domain: 'orders', operation: 'discovery',
        last_sync: new Date(),
        cursor_value: JSON.stringify({ lastEndDate: '2026-08-01' })
      }
    };
  });

  describe('Discovery Phase (ORD-001)', () => {
    it('should call ORD-001 and upsert all discovered orders', async () => {
      const rawOrders = [{ 'nr-pedido': '101' }, { 'nr-pedido': '102' }];
      (deps.ordersProvider as any).getOrders.mockResolvedValue(rawOrders);

      const engine = new OrdersSync(deps);
      const result = await engine.execute(context);

      expect(result.success).toBe(true);
      expect(result.metrics?.discovered).toBe(2);
      expect(deps.ordersRepo.upsertMany).toHaveBeenCalledTimes(1);
    });

    it('should fail if provider throws', async () => {
      (deps.ordersProvider as any).getOrders.mockRejectedValue(new Error('API Timeout'));
      const engine = new OrdersSync(deps);
      const result = await engine.execute(context);

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(deps.ordersRepo.upsertMany).not.toHaveBeenCalled();
    });
  });

  describe('Hydration Phase (ORD-002)', () => {
    it('should hydrate orders that are missing detail', async () => {
      const candidates: OrderCandidate[] = [{ order_id: 'o1', order_number: '101', raw_status: 'Pendente', raw_codsit: null }];
      (deps.ordersRepo as any).findOrdersWithoutDetail.mockResolvedValue(candidates);

      const engine = new OrdersSync(deps);
      await engine.execute(context);

      expect(deps.detailProvider.getOrderDetail).toHaveBeenCalledWith('101', context.abortSignal);
      expect(deps.detailsRepo.upsert).toHaveBeenCalled();
    });

    it('should not block discovery cursor advancement if hydration fails', async () => {
      const candidates: OrderCandidate[] = [{ order_id: 'o1', order_number: '101', raw_status: 'Pendente', raw_codsit: null }];
      (deps.ordersRepo as any).findOrdersWithoutDetail.mockResolvedValue(candidates);
      (deps.detailProvider as any).getOrderDetail.mockRejectedValue(new Error('Internal Server Error 500'));

      const engine = new OrdersSync(deps);
      const result = await engine.execute(context);

      expect(deps.detailProvider.getOrderDetail).toHaveBeenCalledWith('101', context.abortSignal);
      expect(deps.detailsRepo.upsert).not.toHaveBeenCalled();
      expect(result.success).toBe(true); // Must still be true to allow cursor advancement
      expect(result.metrics?.hydration_errors).toBe(1);
    });
  });
});
