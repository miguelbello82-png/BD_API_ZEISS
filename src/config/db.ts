import { Pool, PoolClient, QueryResultRow } from 'pg';

export interface IDatabaseExecutor {
  /** Execute a parameterized SQL query */
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
  
  /** Execute a callback within a database transaction */
  transaction<T>(callback: (client: IDatabaseExecutor) => Promise<T>): Promise<T>;
}

export class PgDatabaseExecutor implements IDatabaseExecutor {
  constructor(private poolOrClient: Pool | PoolClient) {}

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]> {
    const result = await this.poolOrClient.query<R>(sql, params);
    return result.rows;
  }

  async transaction<T>(callback: (client: IDatabaseExecutor) => Promise<T>): Promise<T> {
    // If it's already a PoolClient, we're already inside a transaction conceptually
    // (Nested transactions would require SAVEPOINT, omitted for simplicity)
    if ('release' in this.poolOrClient && typeof this.poolOrClient.release === 'function') {
      return callback(this);
    }

    const pool = this.poolOrClient as Pool;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const executor = new PgDatabaseExecutor(client);
      const result = await callback(executor);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Creates a PostgreSQL pool from the DATABASE_URL environment variable.
 * Does NOT automatically connect on import.
 */
export function createPgPool(connectionString?: string): Pool {
  const url = connectionString || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not defined in the environment.');
  }
  return new Pool({ connectionString: url });
}
