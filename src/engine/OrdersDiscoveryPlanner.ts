import { DateSlice } from '../contracts/types';

export interface DiscoveryPlannerConfig {
  maxRangeDays: number;
}

export class OrdersDiscoveryPlanner {
  /**
   * Plans the next discovery interval based on the last successful end date.
   */
  static planNextSlice(lastEndDate: string | undefined, config: DiscoveryPlannerConfig, nowMillis: number): DateSlice {
    let startDate: Date;
    let endDate = new Date(nowMillis);

    if (lastEndDate) {
      startDate = new Date(lastEndDate);
      if (isNaN(startDate.getTime())) {
        throw new Error('Corrupted cursor: invalid lastEndDate format');
      }
    } else {
      throw new Error('BOOTSTRAP_REQUIRED: No valid cursor exists for continuous orders discovery. Initial bootstrap is required.');
    }

    if (startDate.getTime() > endDate.getTime()) {
      throw new Error('Computed startDate is in the future relative to the current clock.');
    }

    // Limit the maximum range to maxRangeDays
    const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays > config.maxRangeDays) {
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + config.maxRangeDays);
    }

    return {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
    };
  }
}
