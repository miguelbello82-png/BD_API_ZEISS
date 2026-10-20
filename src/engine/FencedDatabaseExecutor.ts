import { IDatabaseExecutor } from '../config/db';
import { QueryResultRow } from 'pg';

export interface LeaseFencingContext {
  storeId: string;
  provider: string;
  domain: string;
  operation: string;
  ownerToken: string;
  isLost?: () => boolean;
}

export class StaleWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleWriteError';
  }
}

/**
 * FencedDatabaseExecutor wraps an IDatabaseExecutor with transactional lease fencing.
 *
 * ACH-02: Guarantees that asynchronous jobs that ignore AbortSignal cannot perform stale writes
 * after lease expiration. Any mutation query (INSERT, UPDATE, DELETE) validates lease ownership
 * inside a transaction with row-level lock (FOR UPDATE) on the lease record, eliminating the
 * Time-Of-Check to Time-Of-Use (TOCTOU) race window.
 */
export class FencedDatabaseExecutor implements IDatabaseExecutor {
  constructor(
    private underlying: IDatabaseExecutor,
    private context: LeaseFencingContext
  ) {}

  private isMutation(sql: string): boolean {
    const trimmed = sql.trim().toUpperCase();
    return (
      trimmed.startsWith('INSERT') ||
      trimmed.startsWith('UPDATE') ||
      trimmed.startsWith('DELETE') ||
      trimmed.startsWith('UPSERT')
    );
  }

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]> {
    if (!this.isMutation(sql)) {
      return this.underlying.query<R>(sql, params);
    }

    if (this.context.isLost && this.context.isLost()) {
      throw new StaleWriteError(
        `Stale write rejected: lease for ${this.context.storeId}:${this.context.provider}:${this.context.domain}:${this.context.operation} was marked lost.`
      );
    }

    return this.underlying.transaction(async (txClient) => {
      await this.validateLeaseOwnership(txClient);
      return txClient.query<R>(sql, params);
    });
  }

  async transaction<T>(callback: (client: IDatabaseExecutor) => Promise<T>): Promise<T> {
    if (this.context.isLost && this.context.isLost()) {
      throw new StaleWriteError(
        `Stale transaction rejected: lease for ${this.context.storeId}:${this.context.provider}:${this.context.domain}:${this.context.operation} was marked lost.`
      );
    }

    return this.underlying.transaction(async (txClient) => {
      await this.validateLeaseOwnership(txClient);
      const fencedTx = new FencedDatabaseExecutor(txClient, this.context);
      return callback(fencedTx);
    });
  }

  private async validateLeaseOwnership(executor: IDatabaseExecutor): Promise<void> {
    const checkSql = `
      SELECT owner_token, expires_at, (expires_at >= CURRENT_TIMESTAMP) AS is_valid
      FROM integration.store_sync_leases
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4
      FOR UPDATE
    `;
    const rows = await executor.query<{ owner_token: string; expires_at: Date; is_valid?: boolean }>(checkSql, [
      this.context.storeId,
      this.context.provider,
      this.context.domain,
      this.context.operation,
    ]);

    if (rows.length === 0) {
      throw new StaleWriteError(
        `Stale write rejected: no active lease found for store ${this.context.storeId} on ${this.context.provider}:${this.context.domain}:${this.context.operation}`
      );
    }

    const currentOwner = rows[0].owner_token;
    if (currentOwner !== this.context.ownerToken) {
      throw new StaleWriteError(
        `Stale write rejected: lease ownership token mismatch (held by ${currentOwner}, caller token ${this.context.ownerToken})`
      );
    }

    const isExpired = rows[0].is_valid === false ||
      (rows[0].expires_at ? new Date(rows[0].expires_at).getTime() < Date.now() : true);
    if (isExpired) {
      throw new StaleWriteError(
        `Stale write rejected: lease for store ${this.context.storeId} on ${this.context.provider}:${this.context.domain}:${this.context.operation} has expired (expired at ${rows[0].expires_at})`
      );
    }
  }
}
