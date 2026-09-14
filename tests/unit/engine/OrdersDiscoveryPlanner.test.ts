import { OrdersDiscoveryPlanner, DiscoveryPlannerConfig } from '../../../src/engine/OrdersDiscoveryPlanner';
import { ISyncStateRepository } from '../../../src/contracts/repositories';
import { ILogger, NullLogger } from '../../../src/observability/Logger';

describe('OrdersDiscoveryPlanner', () => {
  it('1. sem cursor (lastEndDate undefined) -> erro BOOTSTRAP_REQUIRED', () => {
    const nowMillis = new Date('2026-08-21T00:00:00.000Z').getTime();
    expect(() => OrdersDiscoveryPlanner.planNextSlice(undefined, { maxRangeDays: 1000 }, nowMillis))
      .toThrow('BOOTSTRAP_REQUIRED: No valid cursor exists');
  });

  it('3. cursor valido -> retoma', () => {
    const nowMillis = new Date('2026-08-21T00:00:00.000Z').getTime();
    const slice = OrdersDiscoveryPlanner.planNextSlice('2026-05-01', { maxRangeDays: 1000 }, nowMillis);
    
    expect(slice.startDate).toBe('2026-05-01'); // retoma de lastEndDate
    expect(slice.endDate).toBe('2026-08-21');
  });

  it('4. cursor malformado -> erro', () => {
    const nowMillis = new Date('2026-08-21T00:00:00.000Z').getTime();
    expect(() => OrdersDiscoveryPlanner.planNextSlice('invalid-date', { maxRangeDays: 30 }, nowMillis))
      .toThrow('Corrupted cursor: invalid lastEndDate format');
  });

  it('6. start futuro -> erro', () => {
    const nowMillis = new Date('2026-08-21T00:00:00.000Z').getTime();
    expect(() => OrdersDiscoveryPlanner.planNextSlice('2026-09-01', { maxRangeDays: 30 }, nowMillis))
      .toThrow('Computed startDate is in the future');
  });

  it('7. clock injetado; 8. maxRangeDays recebido por config', () => {
    const nowMillis = new Date('2026-08-21T00:00:00.000Z').getTime();
    const slice = OrdersDiscoveryPlanner.planNextSlice('2026-01-01', { maxRangeDays: 5 }, nowMillis);
    
    expect(slice.startDate).toBe('2026-01-01');
    expect(slice.endDate).toBe('2026-01-06'); // 5 days max range capped
  });
});
