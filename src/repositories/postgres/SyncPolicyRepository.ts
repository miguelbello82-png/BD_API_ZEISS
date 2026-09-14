import { IDatabaseExecutor } from '../../config/db';
import { ISyncPolicyRepository, SyncPolicy } from '../../contracts/repositories';

export class PgSyncPolicyRepository implements ISyncPolicyRepository {
  constructor(private db: IDatabaseExecutor) {}

  async findEnabledByProvider(provider: string): Promise<SyncPolicy[]> {
    const query = `
      SELECT provider, domain, operation, enabled, interval_seconds, lookback_seconds, 
             timeout_seconds, lease_ttl_seconds, max_retries, retry_delay_seconds, 
             created_at, updated_at
      FROM integration.sync_policies
      WHERE enabled = true AND provider = $1
    `;
    return await this.db.query<SyncPolicy>(query, [provider]);
  }

  async findAllEnabled(): Promise<SyncPolicy[]> {
    const query = `
      SELECT provider, domain, operation, enabled, interval_seconds, lookback_seconds, timeout_seconds, lease_ttl_seconds, max_retries, retry_delay_seconds
      FROM integration.sync_policies
      WHERE enabled = true
    `;
    return await this.db.query<SyncPolicy>(query);
  }

  async findByKey(provider: string, domain: string, operation: string): Promise<SyncPolicy | null> {
    const query = `
      SELECT provider, domain, operation, enabled, interval_seconds, lookback_seconds, 
             timeout_seconds, lease_ttl_seconds, max_retries, retry_delay_seconds, 
             created_at, updated_at
      FROM integration.sync_policies
      WHERE provider = $1 AND domain = $2 AND operation = $3
    `;
    const result = await this.db.query<SyncPolicy>(query, [provider, domain, operation]);
    return result.length > 0 ? result[0] : null;
  }
}
