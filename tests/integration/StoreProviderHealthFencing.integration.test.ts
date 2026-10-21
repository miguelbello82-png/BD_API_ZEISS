import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { PgDatabaseExecutor } from '../../src/config/db';
import { PgStoreProviderHealthRepository } from '../../src/repositories/postgres/StoreProviderHealthRepository';
import { FencedDatabaseExecutor, StaleWriteError } from '../../src/engine/FencedDatabaseExecutor';

describe('StoreProviderHealthFencing - Real PostgreSQL Concurrency Integration', () => {
  let poolA: Pool;
  let poolB: Pool;
  const storeId = randomUUID();
  const provider = 'zeiss';
  const domain = 'orders';
  const operation = 'discovery';

  const rawConnStr = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/zeiss_test';

  beforeAll(async () => {
    // 1. Mandatory test environment assertion
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('SECURITY VIOLATION: Integration tests can only execute when NODE_ENV is set to "test".');
    }

    // 2. Prevent accidental reuse of production connection string
    if (process.env.DATABASE_URL && rawConnStr.trim() === process.env.DATABASE_URL.trim()) {
      throw new Error('SECURITY VIOLATION: TEST_DATABASE_URL cannot match DATABASE_URL.');
    }

    // 3. Strict loopback validation
    const parsedUrl = new URL(rawConnStr);
    const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    if (!allowedHosts.has(parsedUrl.hostname.toLowerCase())) {
      throw new Error(`SECURITY VIOLATION: Host "${parsedUrl.hostname}" is not loopback.`);
    }

    poolA = new Pool({ connectionString: rawConnStr, max: 2, connectionTimeoutMillis: 5000 });
    poolB = new Pool({ connectionString: rawConnStr, max: 2, connectionTimeoutMillis: 5000 });

    // 4. Assert engine reported address and test database name
    const client = await poolA.connect();
    try {
      const res = await client.query(`
        SELECT 
          current_database() AS db_name, 
          inet_server_addr() AS server_addr
      `);
      const dbInfo = res.rows[0];
      const dbName = String(dbInfo.db_name).toLowerCase();
      if (!dbName.endsWith('_test') && dbName !== 'zeiss_test') {
        throw new Error(`SECURITY VIOLATION: Database "${dbInfo.db_name}" is not a test database.`);
      }

      // 5. Setup tables in integration schema
      await client.query(`CREATE SCHEMA IF NOT EXISTS integration;`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS integration.store_sync_leases (
          store_id UUID NOT NULL,
          provider VARCHAR(50) NOT NULL,
          domain VARCHAR(50) NOT NULL,
          operation VARCHAR(50) NOT NULL,
          owner_token UUID NOT NULL,
          acquired_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMPTZ NOT NULL,
          CONSTRAINT pk_integration_store_sync_leases PRIMARY KEY (store_id, provider, domain, operation)
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS integration.store_provider_health (
          store_id UUID NOT NULL,
          provider VARCHAR(50) NOT NULL,
          domain VARCHAR(50) NOT NULL,
          operation VARCHAR(50) NOT NULL,
          status VARCHAR(50) NULL,
          last_success TIMESTAMPTZ NULL,
          last_failure TIMESTAMPTZ NULL,
          consecutive_failures INT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT pk_integration_store_provider_health PRIMARY KEY (store_id, provider, domain, operation)
        );
      `);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    // Cleanup test data
    const client = await poolA.connect();
    try {
      await client.query('DELETE FROM integration.store_sync_leases WHERE store_id = $1', [storeId]);
      await client.query('DELETE FROM integration.store_provider_health WHERE store_id = $1', [storeId]);
    } finally {
      client.release();
      await poolA.end();
      await poolB.end();
    }
  });

  it('demonstrates lock serialization: Connection A locks lease row with FOR UPDATE and blocks Connection B until commit', async () => {
    const workerA = randomUUID();
    const workerB = randomUUID();

    // Setup initial valid lease for Worker A
    const setupClient = await poolA.connect();
    try {
      await setupClient.query(`
        INSERT INTO integration.store_sync_leases (store_id, provider, domain, operation, owner_token, expires_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + interval '30 seconds')
        ON CONFLICT (store_id, provider, domain, operation)
        DO UPDATE SET owner_token = EXCLUDED.owner_token, expires_at = EXCLUDED.expires_at;
      `, [storeId, provider, domain, operation, workerA]);
    } finally {
      setupClient.release();
    }

    const clientA: PoolClient = await poolA.connect();
    const clientB: PoolClient = await poolB.connect();

    let clientBBlocked = true;
    let clientBLockAcquired = false;

    try {
      // 1. Connection A starts transaction and locks lease row with FOR UPDATE
      await clientA.query('BEGIN');
      await clientA.query(`
        SELECT owner_token, expires_at
        FROM integration.store_sync_leases
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4
        FOR UPDATE;
      `, [storeId, provider, domain, operation]);

      // 2. Connection B attempts to lock the exact same lease row with FOR UPDATE
      const connectionBPromise = (async () => {
        await clientB.query('BEGIN');
        await clientB.query(`
          SELECT owner_token
          FROM integration.store_sync_leases
          WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4
          FOR UPDATE;
        `, [storeId, provider, domain, operation]);
        clientBLockAcquired = true;
        clientBBlocked = false;
        await clientB.query('COMMIT');
      })();

      // 3. Synchronization barrier: wait 150ms and assert Connection B is blocked by A's row lock
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(clientBBlocked).toBe(true);
      expect(clientBLockAcquired).toBe(false);

      // 4. Connection A writes health status and commits
      const executorA = new PgDatabaseExecutor(clientA);
      const healthRepoA = new PgStoreProviderHealthRepository(executorA, storeId);
      await healthRepoA.recordSuccess(provider, domain, operation);
      await clientA.query('COMMIT');

      // 5. Connection B immediately unblocks and acquires the lock
      await connectionBPromise;
      expect(clientBLockAcquired).toBe(true);
      expect(clientBBlocked).toBe(false);

      // Verify health table has HEALTHY
      const healthCheck = await setupClient.query(`
        SELECT status FROM integration.store_provider_health
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
      `, [storeId, provider, domain, operation]);
      expect(healthCheck.rows[0].status).toBe('HEALTHY');
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  it('rejects stale write from Worker A after Worker B assumes the lease, preserving B state', async () => {
    const workerA = randomUUID();
    const workerB = randomUUID();

    const client = await poolA.connect();
    try {
      // Worker B assumes the lease
      await client.query(`
        UPDATE integration.store_sync_leases
        SET owner_token = $5, expires_at = CURRENT_TIMESTAMP + interval '30 seconds'
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
      `, [storeId, provider, domain, operation, workerB]);

      // State is HEALTHY (recorded previously by B)
      await client.query(`
        INSERT INTO integration.store_provider_health (store_id, provider, domain, operation, status)
        VALUES ($1, $2, $3, $4, 'HEALTHY')
        ON CONFLICT (store_id, provider, domain, operation)
        DO UPDATE SET status = 'HEALTHY';
      `, [storeId, provider, domain, operation]);
    } finally {
      client.release();
    }

    // Worker A (stale executor bound to workerA) attempts to recordFailure
    const dbA = new PgDatabaseExecutor(poolA);
    const fencedDbA = new FencedDatabaseExecutor(dbA, {
      storeId,
      provider,
      domain,
      operation,
      ownerToken: workerA
    });
    const healthRepoA = new PgStoreProviderHealthRepository(fencedDbA, storeId);

    // Stale write MUST be rejected atomically with StaleWriteError
    await expect(
      healthRepoA.recordFailure(provider, domain, operation)
    ).rejects.toThrow(StaleWriteError);

    // Verify current state remains HEALTHY (unmodified by stale Worker A)
    const verifyClient = await poolA.connect();
    try {
      const res = await verifyClient.query(`
        SELECT status FROM integration.store_provider_health
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
      `, [storeId, provider, domain, operation]);
      expect(res.rows[0].status).toBe('HEALTHY');
    } finally {
      verifyClient.release();
    }
  });

  it('rejects health write when lease is expired without token replacement', async () => {
    const workerA = randomUUID();

    const client = await poolA.connect();
    try {
      // Token matches workerA, but lease is expired 5 seconds in the past
      await client.query(`
        UPDATE integration.store_sync_leases
        SET owner_token = $5, expires_at = CURRENT_TIMESTAMP - interval '5 seconds'
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
      `, [storeId, provider, domain, operation, workerA]);
    } finally {
      client.release();
    }

    const dbA = new PgDatabaseExecutor(poolA);
    const fencedDbA = new FencedDatabaseExecutor(dbA, {
      storeId,
      provider,
      domain,
      operation,
      ownerToken: workerA
    });
    const healthRepoA = new PgStoreProviderHealthRepository(fencedDbA, storeId);

    // Must be rejected because lease expired
    await expect(
      healthRepoA.recordSuccess(provider, domain, operation)
    ).rejects.toThrow(StaleWriteError);
  });

  it('allows legitimate failure recording under an active valid lease', async () => {
    const workerB = randomUUID();

    const client = await poolA.connect();
    try {
      // Worker B holds active lease
      await client.query(`
        UPDATE integration.store_sync_leases
        SET owner_token = $5, expires_at = CURRENT_TIMESTAMP + interval '30 seconds'
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
      `, [storeId, provider, domain, operation, workerB]);
    } finally {
      client.release();
    }

    const dbB = new PgDatabaseExecutor(poolB);
    const fencedDbB = new FencedDatabaseExecutor(dbB, {
      storeId,
      provider,
      domain,
      operation,
      ownerToken: workerB
    });
    const healthRepoB = new PgStoreProviderHealthRepository(fencedDbB, storeId);

    // Worker B records failure under valid active lease
    await healthRepoB.recordFailure(provider, domain, operation);

    // Verify health status is DEGRADED
    const verifyClient = await poolB.connect();
    try {
      const res = await verifyClient.query(`
        SELECT status FROM integration.store_provider_health
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
      `, [storeId, provider, domain, operation]);
      expect(res.rows[0].status).toBe('DEGRADED');
    } finally {
      verifyClient.release();
    }
  });

  it('preserves unfenced administrative health updates when not operating under a job lease', async () => {
    const db = new PgDatabaseExecutor(poolA);
    const administrativeHealthRepo = new PgStoreProviderHealthRepository(db, storeId);

    // Administrative update does not require lease
    await administrativeHealthRepo.recordSuccess(provider, domain, operation);

    const verifyClient = await poolA.connect();
    try {
      const res = await verifyClient.query(`
        SELECT status FROM integration.store_provider_health
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
      `, [storeId, provider, domain, operation]);
      expect(res.rows[0].status).toBe('HEALTHY');
    } finally {
      verifyClient.release();
    }
  });
});
