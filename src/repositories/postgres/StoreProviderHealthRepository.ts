import { IDatabaseExecutor } from '../../config/db';
import { IProviderHealthRepository, ProviderHealthRecord } from '../../contracts/repositories';

export class PgStoreProviderHealthRepository implements IProviderHealthRepository {
  constructor(
    private db: IDatabaseExecutor,
    private storeId: string
  ) {}

  getStoreId(): string {
    return this.storeId;
  }

  async findByKey(provider: string, domain: string, operation: string): Promise<ProviderHealthRecord | null> {
    const query = `
      SELECT provider, domain, operation, status, last_success, last_failure
      FROM integration.store_provider_health
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4
    `;
    const result = await this.db.query<ProviderHealthRecord>(query, [this.storeId, provider, domain, operation]);
    return result.length > 0 ? result[0] : null;
  }

  async recordSuccess(provider: string, domain: string, operation: string): Promise<void> {
    const query = `
      INSERT INTO integration.store_provider_health (store_id, provider, domain, operation, status, last_success, updated_at)
      VALUES ($1, $2, $3, $4, 'HEALTHY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (store_id, provider, domain, operation)
      DO UPDATE SET
        status = 'HEALTHY',
        last_success = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `;
    await this.db.query(query, [this.storeId, provider, domain, operation]);
  }

  async recordFailure(provider: string, domain: string, operation: string): Promise<void> {
    const query = `
      INSERT INTO integration.store_provider_health (store_id, provider, domain, operation, status, last_failure, updated_at)
      VALUES ($1, $2, $3, $4, 'DEGRADED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (store_id, provider, domain, operation)
      DO UPDATE SET
        status = 'DEGRADED',
        last_failure = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `;
    await this.db.query(query, [this.storeId, provider, domain, operation]);
  }
}
