import { IDatabaseExecutor } from '../../config/db';
import { ISyncLeaseRepository, SyncLease } from '../../contracts/repositories';

export class PgSyncLeaseRepository implements ISyncLeaseRepository {
  constructor(private db: IDatabaseExecutor) {}

  async tryAcquire(provider: string, domain: string, operation: string, ownerToken: string, ttlSeconds: number): Promise<{ acquired: boolean }> {
    const query = `
      INSERT INTO integration.sync_leases 
        (provider, domain, operation, owner_token, expires_at)
      VALUES 
        ($1, $2, $3, $4, CURRENT_TIMESTAMP + ($5 || ' seconds')::interval)
      ON CONFLICT (provider, domain, operation) 
      DO UPDATE SET
        owner_token = EXCLUDED.owner_token,
        acquired_at = CURRENT_TIMESTAMP,
        expires_at = EXCLUDED.expires_at
      WHERE integration.sync_leases.expires_at < CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const result = await this.db.query(query, [provider, domain, operation, ownerToken, ttlSeconds]);
    return { acquired: result.length > 0 };
  }

  async release(provider: string, domain: string, operation: string, ownerToken: string): Promise<void> {
    const query = `
      DELETE FROM integration.sync_leases
      WHERE provider = $1 AND domain = $2 AND operation = $3 AND owner_token = $4
    `;
    await this.db.query(query, [provider, domain, operation, ownerToken]);
  }

  async renew(provider: string, domain: string, operation: string, ownerToken: string, ttlSeconds: number): Promise<boolean> {
    const query = `
      UPDATE integration.sync_leases
      SET expires_at = CURRENT_TIMESTAMP + ($5 || ' seconds')::interval
      WHERE provider = $1 AND domain = $2 AND operation = $3 AND owner_token = $4 AND expires_at >= CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const result = await this.db.query(query, [provider, domain, operation, ownerToken, ttlSeconds]);
    return result.length > 0;
  }

  async findActive(provider: string, domain: string, operation: string): Promise<SyncLease | null> {
    const query = `
      SELECT provider, domain, operation, owner_token, acquired_at, expires_at 
      FROM integration.sync_leases
      WHERE provider = $1 AND domain = $2 AND operation = $3 AND expires_at >= CURRENT_TIMESTAMP
    `;
    const result = await this.db.query(query, [provider, domain, operation]);
    if (result.length === 0) return null;
    return result[0] as SyncLease;
  }
}
