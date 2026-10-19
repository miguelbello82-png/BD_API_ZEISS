import { IDatabaseExecutor } from '../../config/db';
import { ISyncLeaseRepository, SyncLease } from '../../contracts/repositories';

export class PgStoreSyncLeaseRepository implements ISyncLeaseRepository {
  constructor(
    private db: IDatabaseExecutor,
    private storeId: string
  ) {}

  getStoreId(): string {
    return this.storeId;
  }

  async tryAcquire(
    provider: string,
    domain: string,
    operation: string,
    ownerToken: string,
    ttlSeconds: number
  ): Promise<{ acquired: boolean }> {
    const query = `
      INSERT INTO integration.store_sync_leases 
        (store_id, provider, domain, operation, owner_token, expires_at)
      VALUES 
        ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + ($6 || ' seconds')::interval)
      ON CONFLICT (store_id, provider, domain, operation) 
      DO UPDATE SET
        owner_token = EXCLUDED.owner_token,
        acquired_at = CURRENT_TIMESTAMP,
        expires_at = EXCLUDED.expires_at
      WHERE integration.store_sync_leases.expires_at < CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const result = await this.db.query(query, [this.storeId, provider, domain, operation, ownerToken, ttlSeconds]);
    return { acquired: result.length > 0 };
  }

  async release(provider: string, domain: string, operation: string, ownerToken: string): Promise<void> {
    const query = `
      DELETE FROM integration.store_sync_leases
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4 AND owner_token = $5
    `;
    await this.db.query(query, [this.storeId, provider, domain, operation, ownerToken]);
  }

  async renew(
    provider: string,
    domain: string,
    operation: string,
    ownerToken: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const query = `
      UPDATE integration.store_sync_leases
      SET expires_at = CURRENT_TIMESTAMP + ($6 || ' seconds')::interval
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4 AND owner_token = $5 AND expires_at >= CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const result = await this.db.query(query, [this.storeId, provider, domain, operation, ownerToken, ttlSeconds]);
    return result.length > 0;
  }

  async findActive(provider: string, domain: string, operation: string): Promise<SyncLease | null> {
    const query = `
      SELECT provider, domain, operation, owner_token, acquired_at, expires_at 
      FROM integration.store_sync_leases
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4 AND expires_at >= CURRENT_TIMESTAMP
    `;
    const result = await this.db.query(query, [this.storeId, provider, domain, operation]);
    if (result.length === 0) return null;
    return result[0] as SyncLease;
  }
}
