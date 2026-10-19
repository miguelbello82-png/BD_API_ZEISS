import { IDatabaseExecutor } from '../../config/db';
import { ISyncPolicyRepository, SyncPolicy } from '../../contracts/repositories';

export class PgStoreSyncPolicyRepository implements ISyncPolicyRepository {
  constructor(
    private db: IDatabaseExecutor,
    private storeId: string
  ) {}

  getStoreId(): string {
    return this.storeId;
  }

  async findEnabledByProvider(provider: string): Promise<SyncPolicy[]> {
    const query = `
      SELECT provider, domain, operation, enabled, interval_seconds, lookback_seconds, 
             timeout_seconds, lease_ttl_seconds, max_retries, retry_delay_seconds, 
             operation_config, created_at, updated_at
      FROM integration.store_sync_policies
      WHERE store_id = $1 AND enabled = true AND provider = $2
    `;
    return await this.db.query<SyncPolicy>(query, [this.storeId, provider]);
  }

  async findAllEnabled(): Promise<SyncPolicy[]> {
    const query = `
      SELECT provider, domain, operation, enabled, interval_seconds, lookback_seconds, 
             timeout_seconds, lease_ttl_seconds, max_retries, retry_delay_seconds, 
             operation_config
      FROM integration.store_sync_policies
      WHERE store_id = $1 AND enabled = true
    `;
    return await this.db.query<SyncPolicy>(query, [this.storeId]);
  }

  async findByKey(provider: string, domain: string, operation: string): Promise<SyncPolicy | null> {
    const query = `
      SELECT provider, domain, operation, enabled, interval_seconds, lookback_seconds, 
             timeout_seconds, lease_ttl_seconds, max_retries, retry_delay_seconds, 
             operation_config, created_at, updated_at
      FROM integration.store_sync_policies
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4
    `;
    const result = await this.db.query<SyncPolicy>(query, [this.storeId, provider, domain, operation]);
    return result.length > 0 ? result[0] : null;
  }
}
