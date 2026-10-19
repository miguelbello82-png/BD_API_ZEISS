import { IDatabaseExecutor } from '../../config/db';
import { ISyncStateRepository, SyncState } from '../../contracts/repositories';

interface StoreSyncStateDbRow {
  provider: string;
  domain: string;
  operation: string;
  last_sync: Date | null;
  cursor_value: unknown;
}

export class PgStoreSyncStateRepository implements ISyncStateRepository {
  constructor(
    private db: IDatabaseExecutor,
    private storeId: string
  ) {}

  getStoreId(): string {
    return this.storeId;
  }

  async findByKey(provider: string, domain: string, operation: string): Promise<SyncState | null> {
    const query = `
      SELECT provider, domain, operation, last_sync, cursor_value
      FROM integration.store_sync_state
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4
    `;
    const result = await this.db.query<StoreSyncStateDbRow>(query, [this.storeId, provider, domain, operation]);
    if (result.length === 0) return null;

    const row = result[0];
    return {
      provider: row.provider,
      domain: row.domain,
      operation: row.operation,
      last_sync: row.last_sync,
      cursor_value: typeof row.cursor_value === 'object' && row.cursor_value !== null
        ? JSON.stringify(row.cursor_value)
        : (row.cursor_value as string | null)
    };
  }

  async upsert(state: SyncState): Promise<void> {
    const query = `
      INSERT INTO integration.store_sync_state (store_id, provider, domain, operation, last_sync, cursor_value, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (store_id, provider, domain, operation)
      DO UPDATE SET
        last_sync = EXCLUDED.last_sync,
        cursor_value = COALESCE(EXCLUDED.cursor_value, integration.store_sync_state.cursor_value),
        updated_at = CURRENT_TIMESTAMP
    `;
    await this.db.query(query, [
      this.storeId,
      state.provider,
      state.domain,
      state.operation,
      state.last_sync,
      state.cursor_value
    ]);
  }
}
