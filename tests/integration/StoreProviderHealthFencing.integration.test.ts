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

    poolA = new Pool({ connectionString: rawConnStr, max: 10, connectionTimeoutMillis: 5000 });
    poolB = new Pool({ connectionString: rawConnStr, max: 10, connectionTimeoutMillis: 5000 });

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
    try {
      await poolA.query('DELETE FROM integration.store_sync_leases WHERE store_id = $1', [storeId]);
      await poolA.query('DELETE FROM integration.store_provider_health WHERE store_id = $1', [storeId]);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });

  const waitForLockContention = async (waitingPid: number, maxWaitMs = 3000): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const res = await poolA.query<{ waiting: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted
        ) OR EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'
        ) AS waiting
      `, [waitingPid]);
      if (res.rows[0]?.waiting) {
        return true;
      }
      await new Promise(r => setTimeout(r, 20));
    }
    return false;
  };

  it('demonstrates that FencedDatabaseExecutor locks lease row, blocks concurrent Worker B until commit, and rejects stale write from A', async () => {
    const workerA = randomUUID();
    const workerB = randomUUID();

    // 1. Worker A adquire lease inicial válido no banco
    await poolA.query(`
      INSERT INTO integration.store_sync_leases (store_id, provider, domain, operation, owner_token, expires_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + interval '30 seconds')
      ON CONFLICT (store_id, provider, domain, operation)
      DO UPDATE SET owner_token = EXCLUDED.owner_token, expires_at = EXCLUDED.expires_at;
    `, [storeId, provider, domain, operation, workerA]);

    // Instancia FencedDatabaseExecutor real para Worker A
    const dbA = new PgDatabaseExecutor(poolA);
    const fencedDbA = new FencedDatabaseExecutor(dbA, {
      storeId,
      provider,
      domain,
      operation,
      ownerToken: workerA
    });

    // Conexão B independente dedicada
    const clientB: PoolClient = await poolB.connect();
    let bCompleted = false;
    let bLockWaitDetected = false;

    try {
      const pidBResult = await clientB.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pidB = pidBResult.rows[0].pid;

      // Synchronization barrier promises
      let notifyALockAcquired!: () => void;
      const aLockAcquiredPromise = new Promise<void>((resolve) => {
        notifyALockAcquired = resolve;
      });

      let allowACommit!: () => void;
      const allowACommitPromise = new Promise<void>((resolve) => {
        allowACommit = resolve;
      });

      // Worker A inicia transação protegida através do FencedDatabaseExecutor real
      const aTransactionPromise = fencedDbA.transaction(async (fencedTx) => {
        // Neste ponto, o FencedDatabaseExecutor já executou validateLeaseOwnership(txClient),
        // adquirindo o lock FOR UPDATE na linha de store_sync_leases para esta conexão e transação!
        notifyALockAcquired();

        // Aguarda a confirmação de que Worker B tentou assumir o lease e ficou retido no lock
        await allowACommitPromise;

        // Worker A grava health com sucesso através do repositório fenced real
        const healthRepoA = new PgStoreProviderHealthRepository(fencedTx, storeId);
        await healthRepoA.recordSuccess(provider, domain, operation);
      });

      // Aguarda Worker A adquirir o lock de linha via FencedDatabaseExecutor
      await aLockAcquiredPromise;

      // Worker B na Conexão B tenta assumir o lease atualizando o owner_token para workerB
      const bUpdatePromise = (async () => {
        await clientB.query(`
          UPDATE integration.store_sync_leases
          SET owner_token = $5, expires_at = CURRENT_TIMESTAMP + interval '30 seconds'
          WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
        `, [storeId, provider, domain, operation, workerB]);
        bCompleted = true;
      })();

      // Verifica de forma determinística no PostgreSQL se Conexão B está bloqueada por lock
      bLockWaitDetected = await waitForLockContention(pidB);
      expect(bLockWaitDetected).toBe(true);
      expect(bCompleted).toBe(false);

      // Libera Worker A para gravar health e realizar o COMMIT
      allowACommit();
      await aTransactionPromise;

      // Uma vez que A confirmou, o lock é liberado e Worker B avança e conclui
      await bUpdatePromise;
      expect(bCompleted).toBe(true);

      // Verifica se o estado gravado por A foi registrado como HEALTHY
      const healthAfterA = await poolA.query<{ status: string }>(`
        SELECT status FROM integration.store_provider_health
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
      `, [storeId, provider, domain, operation]);
      expect(healthAfterA.rows[0].status).toBe('HEALTHY');

      // Agora Worker B é o dono soberano do lease.
      // Worker A tenta tardiamente atualizar health via FencedDatabaseExecutor real (recordFailure)
      const staleHealthRepoA = new PgStoreProviderHealthRepository(fencedDbA, storeId);
      await expect(
        staleHealthRepoA.recordFailure(provider, domain, operation)
      ).rejects.toThrow(StaleWriteError);

      // Verifica que o estado HEALTHY permanece preservado, sem corrupção pela tentativa tardia de A
      const healthAfterStaleA = await poolA.query<{ status: string }>(`
        SELECT status FROM integration.store_provider_health
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
      `, [storeId, provider, domain, operation]);
      expect(healthAfterStaleA.rows[0].status).toBe('HEALTHY');
    } finally {
      clientB.release();
    }
  });

  it('rejects health write when lease is expired without token replacement', async () => {
    const workerA = randomUUID();

    // Token matches workerA, but lease is expired 5 seconds in the past
    await poolA.query(`
      UPDATE integration.store_sync_leases
      SET owner_token = $5, expires_at = CURRENT_TIMESTAMP - interval '5 seconds'
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
    `, [storeId, provider, domain, operation, workerA]);

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

    // Worker B holds active lease
    await poolA.query(`
      UPDATE integration.store_sync_leases
      SET owner_token = $5, expires_at = CURRENT_TIMESTAMP + interval '30 seconds'
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
    `, [storeId, provider, domain, operation, workerB]);

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
    const res = await poolB.query<{ status: string }>(`
      SELECT status FROM integration.store_provider_health
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
    `, [storeId, provider, domain, operation]);
    expect(res.rows[0].status).toBe('DEGRADED');
  });

  it('preserves unfenced administrative health updates when not operating under a job lease', async () => {
    const db = new PgDatabaseExecutor(poolA);
    const administrativeHealthRepo = new PgStoreProviderHealthRepository(db, storeId);

    // Administrative update does not require lease
    await administrativeHealthRepo.recordSuccess(provider, domain, operation);

    const res = await poolA.query<{ status: string }>(`
      SELECT status FROM integration.store_provider_health
      WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
    `, [storeId, provider, domain, operation]);
    expect(res.rows[0].status).toBe('HEALTHY');
  });

  it('verifies stability and repeatability of the concurrency lock barrier across multiple iterations', async () => {
    // Repetição determinística para comprovação estrita de ausência de flakiness
    for (let iteration = 1; iteration <= 3; iteration++) {
      const iterWorkerA = randomUUID();
      const iterWorkerB = randomUUID();

      await poolA.query(`
        UPDATE integration.store_sync_leases
        SET owner_token = $5, expires_at = CURRENT_TIMESTAMP + interval '30 seconds'
        WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
      `, [storeId, provider, domain, operation, iterWorkerA]);

      const dbA = new PgDatabaseExecutor(poolA);
      const fencedDbA = new FencedDatabaseExecutor(dbA, {
        storeId,
        provider,
        domain,
        operation,
        ownerToken: iterWorkerA
      });

      const clientB = await poolB.connect();
      try {
        const pidBResult = await clientB.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const pidB = pidBResult.rows[0].pid;

        let notifyALockAcquired!: () => void;
        const aLockAcquiredPromise = new Promise<void>((resolve) => {
          notifyALockAcquired = resolve;
        });

        let allowACommit!: () => void;
        const allowACommitPromise = new Promise<void>((resolve) => {
          allowACommit = resolve;
        });

        const aTxPromise = fencedDbA.transaction(async (fencedTx) => {
          notifyALockAcquired();
          await allowACommitPromise;
          const healthRepoA = new PgStoreProviderHealthRepository(fencedTx, storeId);
          await healthRepoA.recordSuccess(provider, domain, operation);
        });

        await aLockAcquiredPromise;

        let bDone = false;
        const bPromise = clientB.query(`
          UPDATE integration.store_sync_leases
          SET owner_token = $5, expires_at = CURRENT_TIMESTAMP + interval '30 seconds'
          WHERE store_id = $1 AND provider = $2 AND domain = $3 AND operation = $4;
        `, [storeId, provider, domain, operation, iterWorkerB]).then(() => { bDone = true; });

        const isContending = await waitForLockContention(pidB);
        expect(isContending).toBe(true);
        expect(bDone).toBe(false);

        allowACommit();
        await aTxPromise;
        await bPromise;
        expect(bDone).toBe(true);

        // Stale write rejection
        const staleRepoA = new PgStoreProviderHealthRepository(fencedDbA, storeId);
        await expect(staleRepoA.recordFailure(provider, domain, operation)).rejects.toThrow(StaleWriteError);
      } finally {
        clientB.release();
      }
    }
  });
});
