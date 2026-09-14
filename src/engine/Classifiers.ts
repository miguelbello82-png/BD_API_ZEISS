// ============================================================
// Classifiers — BD_API_ZEISS Platform
// ============================================================
// State classification logic. Separates the definition of
// lifecycle stages (e.g. "is this order billed?") from the
// sync infrastructure.
// ============================================================

import { OrderStateInput, TrackingStateInput } from '../contracts/types';

export enum OrderLifecycleStage {
  UNKNOWN = 'UNKNOWN',
  MUTABLE = 'MUTABLE',
  BILLED_LOGISTICS_READY = 'BILLED_LOGISTICS_READY',
  CANCELLED = 'CANCELLED',
}

export interface IOrderClassifier {
  /** Map raw ZEISS fields to a canonical lifecycle stage. */
  classify(state: OrderStateInput): OrderLifecycleStage;

  /** True if the order might still be modified (e.g. not billed/shipped/cancelled). */
  isMutable(state: OrderStateInput): boolean;

  /** True if the order is billed and ready for logistics tracking. */
  isBilledLogisticsReady(state: OrderStateInput): boolean;
  
  /** True if the order is officially cancelled. */
  isCancelled(state: OrderStateInput): boolean;
}

import { OrderStateMappingConfig } from '../config/OrderStateMappingLoader';

export class ZeissOrderClassifier implements IOrderClassifier {
  constructor(private config: OrderStateMappingConfig) {}

  classify(state: OrderStateInput): OrderLifecycleStage {
    if (!state) return OrderLifecycleStage.UNKNOWN;

    // CANCELLED has absolute precedence
    const cancelField = this.config.cancelled.field as keyof OrderStateInput;
    if (state[cancelField] && this.config.cancelled.values.includes(String(state[cancelField]))) {
      return OrderLifecycleStage.CANCELLED;
    }

    if (state.codsit && this.config.billed.codsit.includes(state.codsit)) {
      return OrderLifecycleStage.BILLED_LOGISTICS_READY;
    }

    return OrderLifecycleStage.UNKNOWN;
  }

  isMutable(state: OrderStateInput): boolean {
    const stage = this.classify(state);
    // UNKNOWN is treated as MUTABLE (conservative behavior to keep refreshing)
    return stage === OrderLifecycleStage.MUTABLE || stage === OrderLifecycleStage.UNKNOWN;
  }

  isBilledLogisticsReady(state: OrderStateInput): boolean {
    return this.classify(state) === OrderLifecycleStage.BILLED_LOGISTICS_READY;
  }
  
  isCancelled(state: OrderStateInput): boolean {
    return this.classify(state) === OrderLifecycleStage.CANCELLED;
  }
}

// ----- Tracking -----

export enum TrackingLifecycleStage {
  UNKNOWN = 'UNKNOWN',
  ACTIVE = 'ACTIVE',
  TERMINAL = 'TERMINAL',
}

export interface ITrackingClassifier {
  /** Map a raw ZEISS tracking status to a canonical stage. */
  classify(state: TrackingStateInput | null): TrackingLifecycleStage;

  /** True if tracking is no longer active (delivered, returned). */
  isTerminal(state: TrackingStateInput | null): boolean;
}

export class UnresolvedTrackingClassifier implements ITrackingClassifier {
  classify(state: TrackingStateInput | null): TrackingLifecycleStage {
    return TrackingLifecycleStage.UNKNOWN;
  }

  isTerminal(state: TrackingStateInput | null): boolean {
    return false; // Keep active until proven terminal
  }
}
