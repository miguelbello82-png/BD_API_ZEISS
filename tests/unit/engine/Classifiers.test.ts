import { ZeissOrderClassifier, OrderLifecycleStage } from '../../../src/engine/Classifiers';
import { OrderStateMappingConfig } from '../../../src/config/OrderStateMappingLoader';
import { OrderStateInput } from '../../../src/contracts/types';

describe('ZeissOrderClassifier', () => {
  let classifier: ZeissOrderClassifier;
  let mockConfig: OrderStateMappingConfig;

  beforeEach(() => {
    mockConfig = {
      cancelled: { field: 'status', values: ['Cancelado'] },
      billed: { codsit: ['6.1'] }
    };
    classifier = new ZeissOrderClassifier(mockConfig);
  });

  it('classifies codsit 6.1 as BILLED_LOGISTICS_READY', () => {
    const state: OrderStateInput = { codsit: '6.1', status: 'Faturado' };
    expect(classifier.classify(state)).toBe(OrderLifecycleStage.BILLED_LOGISTICS_READY);
    expect(classifier.isBilledLogisticsReady(state)).toBe(true);
    expect(classifier.isMutable(state)).toBe(false);
    expect(classifier.isCancelled(state)).toBe(false);
  });

  it('classifies Cancelado as CANCELLED with precedence over 6.1', () => {
    const state1: OrderStateInput = { codsit: '', status: 'Cancelado' };
    expect(classifier.classify(state1)).toBe(OrderLifecycleStage.CANCELLED);
    expect(classifier.isCancelled(state1)).toBe(true);
    expect(classifier.isMutable(state1)).toBe(false);

    const state2: OrderStateInput = { codsit: '6.1', status: 'Cancelado' }; // Cancelled + codsit 6.1
    expect(classifier.classify(state2)).toBe(OrderLifecycleStage.CANCELLED);
    expect(classifier.isCancelled(state2)).toBe(true);
    expect(classifier.isBilledLogisticsReady(state2)).toBe(false);
  });

  it('classifies known active statuses as MUTABLE', () => {
    const activeStates: OrderStateInput[] = [
      { codsit: '1.1', status: 'Estoque' },
      { codsit: '2.4', status: 'Tratamento' },
      { codsit: '4.1', status: 'Em separação' },
    ];

    for (const state of activeStates) {
      expect(classifier.classify(state)).toBe(OrderLifecycleStage.UNKNOWN);
      expect(classifier.isMutable(state)).toBe(true);
      expect(classifier.isBilledLogisticsReady(state)).toBe(false);
    }
  });

  it('classifies unknown statuses as UNKNOWN, but keeps them MUTABLE (conservative behavior)', () => {
    const state: OrderStateInput = { codsit: '99.9', status: 'Unknown Status' };
    expect(classifier.classify(state)).toBe(OrderLifecycleStage.UNKNOWN);
    expect(classifier.isMutable(state)).toBe(true);
    expect(classifier.isBilledLogisticsReady(state)).toBe(false);
  });

  it('classifies null or missing state as UNKNOWN', () => {
    expect(classifier.classify({} as any)).toBe(OrderLifecycleStage.UNKNOWN);
    expect(classifier.isMutable({} as any)).toBe(true);
  });
});
