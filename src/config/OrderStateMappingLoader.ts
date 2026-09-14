import * as fs from 'fs';
import * as path from 'path';

export interface OrderStateMappingConfig {
  cancelled: {
    field: string;
    values: string[];
  };
  billed: {
    codsit: string[];
  };
}

export class OrderStateMappingLoader {
  private static readonly CONFIG_PATH = path.resolve(__dirname, '../../config/zeiss/order-state-mapping.json');

  static load(): OrderStateMappingConfig {
    if (!fs.existsSync(this.CONFIG_PATH)) {
      throw new Error(`OrderStateMappingLoader: Missing configuration file at ${this.CONFIG_PATH}`);
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.CONFIG_PATH, 'utf8');
    } catch (e: unknown) {
      throw new Error(`OrderStateMappingLoader: Failed to read config file - ${e instanceof Error ? e.message : String(e)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: unknown) {
      throw new Error(`OrderStateMappingLoader: Invalid JSON in config - ${e instanceof Error ? e.message : String(e)}`);
    }

    this.validate(parsed as Record<string, unknown>);

    return parsed as OrderStateMappingConfig;
  }

  private static validate(config: Record<string, unknown>): void {
    if (!config || typeof config !== 'object') {
      throw new Error('OrderStateMappingLoader: Config must be an object');
    }

    const cancelledObj = config.cancelled as Record<string, unknown> | undefined;
    if (!cancelledObj || typeof cancelledObj !== 'object') {
      throw new Error('OrderStateMappingLoader: Missing or invalid "cancelled" block');
    }
    
    if (cancelledObj.field !== 'status' && cancelledObj.field !== 'codsit') {
      throw new Error('OrderStateMappingLoader: "cancelled.field" must be strictly "status" or "codsit"');
    }

    if (!Array.isArray(cancelledObj.values) || cancelledObj.values.length === 0) {
      throw new Error('OrderStateMappingLoader: "cancelled.values" must be a non-empty array');
    }

    if (cancelledObj.values.some((v: unknown) => typeof v !== 'string' || v.trim() === '')) {
      throw new Error('OrderStateMappingLoader: "cancelled.values" must contain only non-empty strings');
    }

    const billedObj = config.billed as Record<string, unknown> | undefined;
    if (!billedObj || typeof billedObj !== 'object') {
      throw new Error('OrderStateMappingLoader: Missing or invalid "billed" block');
    }

    if (!Array.isArray(billedObj.codsit) || billedObj.codsit.length === 0) {
      throw new Error('OrderStateMappingLoader: "billed.codsit" must be a non-empty array');
    }

    if (billedObj.codsit.some((v: unknown) => typeof v !== 'string' || v.trim() === '')) {
      throw new Error('OrderStateMappingLoader: "billed.codsit" must contain only non-empty strings');
    }
  }
}
