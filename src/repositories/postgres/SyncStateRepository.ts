import { IDatabaseExecutor } from '../../config/db';
import { ISyncStateRepository, SyncState } from '../../contracts/repositories';

interface SyncStateDbRow {
  provider: string;
  domain: string;
  operation: string;
  last_sync: Date | null;
  cursor_value: unknown;
}

export class PgSyncStateRepository implements ISyncStateRepository {
  constructor(private db: IDatabaseExecutor) {}

  async findByKey(provider: string, domain: string, operation: string): Promise<SyncState | null> {
    const query = `
      SELECT provider, domain, operation, last_sync, cursor_value
      FROM integration.sync_state
      WHERE provider = $1 AND domain = $2 AND operation = $3
    `;
    const result = await this.db.query<SyncStateDbRow>(query, [provider, domain, operation]);
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
      INSERT INTO integration.sync_state (provider, domain, operation, last_sync, cursor_value)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (provider, domain, operation)
      DO UPDATE SET
        last_sync = EXCLUDED.last_sync,
        cursor_value = COALESCE(EXCLUDED.cursor_value, integration.sync_state.cursor_value)
    `;
    await this.db.query(query, [
      state.provider,
      state.domain,
      state.operation,
      state.last_sync,
      state.cursor_value
    ]);
  }
}
