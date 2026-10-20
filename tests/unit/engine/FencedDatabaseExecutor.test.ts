import { IDatabaseExecutor } from '../../../src/config/db';
import { FencedDatabaseExecutor, StaleWriteError, LeaseFencingContext } from '../../../src/engine/FencedDatabaseExecutor';
import { buildStoreCompositionDeps } from '../../../src/engine/StoreCompositionRoot';
import { StoreZeissContext } from '../../../src/contracts/store';
import { PgStoreProviderHealthRepository } from '../../../src/repositories/postgres/StoreProviderHealthRepository';

interface LeaseRecord {
  store_id: string;
  provider: string;
  domain: string;
  operation: string;
  owner_token: string;
  expires_at: Date;
}

interface OrderRecord {
  order_number: string;
  store_id: string;
}

interface HealthRecord {
  store_id: string;
  provider: string;
  domain: string;
  operation: string;
  status: string;
  last_success?: Date;
  last_failure?: Date;
}

class RealisticSimulatedDatabase implements IDatabaseExecutor {
  public leases: Map<string, LeaseRecord> = new Map();
  public orders: OrderRecord[] = [];
  public health: Map<string, HealthRecord> = new Map();

  public activeTransactions: { id: number; queries: string[]; committed: boolean; rolledBack: boolean }[] = [];
  private nextTxId = 1;

  private leaseKey(storeId: string, provider: string, domain: string, operation: string): string {
    return `${storeId}:${provider}:${domain}:${operation}`;
  }

  setLease(record: LeaseRecord): void {
    this.leases.set(this.leaseKey(record.store_id, record.provider, record.domain, record.operation), {
      ...record,
      expires_at: new Date(record.expires_at)
    });
  }

  async query<R = any>(sql: string, params?: unknown[]): Promise<R[]> {
    return this.executeQuery<R>(sql, params, null);
  }

  async transaction<T>(callback: (client: IDatabaseExecutor) => Promise<T>): Promise<T> {
    const txId = this.nextTxId++;
    const txRecord = { id: txId, queries: ['BEGIN'], committed: false, rolledBack: false };
    this.activeTransactions.push(txRecord);

    const txClient: IDatabaseExecutor = {
      query: async <R = any>(sql: string, params?: unknown[]): Promise<R[]> => {
        txRecord.queries.push(sql);
        return this.executeQuery<R>(sql, params, txId);
      },
      transaction: async <SubT>(cb: (client: IDatabaseExecutor) => Promise<SubT>): Promise<SubT> => {
        return cb(txClient);
      }
    };

    try {
      const result = await callback(txClient);
      txRecord.queries.push('COMMIT');
      txRecord.committed = true;
      return result;
    } catch (err) {
      txRecord.queries.push('ROLLBACK');
      txRecord.rolledBack = true;
      throw err;
    }
  }

  private executeQuery<R = any>(sql: string, params?: unknown[], txId?: number | null): R[] {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // Query for store_sync_leases FOR UPDATE
    if (normalized.includes('FROM integration.store_sync_leases') && normalized.includes('FOR UPDATE')) {
      const [storeId, provider, domain, operation] = (params || []) as [string, string, string, string];
      const key = this.leaseKey(storeId, provider, domain, operation);
      const lease = this.leases.get(key);

      if (!lease) {
        return [] as R[];
      }

      // Check if query requested CURRENT_TIMESTAMP evaluation
      if (normalized.includes('expires_at >= CURRENT_TIMESTAMP')) {
        const isValid = lease.expires_at.getTime() >= Date.now();
        return [
          {
            owner_token: lease.owner_token,
            expires_at: lease.expires_at,
            is_valid: isValid
          }
        ] as R[];
      }

      // Realistic unpatched behavior: return existing row without evaluating expiration
      return [
        {
          owner_token: lease.owner_token,
          expires_at: lease.expires_at
        }
      ] as R[];
    }

    // Insert orders
    if (normalized.includes('INSERT INTO zeiss.orders')) {
      const [orderNumber, storeId] = (params || []) as [string, string];
      this.orders.push({ order_number: orderNumber, store_id: storeId });
      return [] as R[];
    }

    // Upsert store_provider_health
    if (normalized.includes('integration.store_provider_health')) {
      const [storeId, provider, domain, operation] = (params || []) as [string, string, string, string];
      const key = this.leaseKey(storeId, provider, domain, operation);
      const isSuccess = normalized.includes("'HEALTHY'");
      const existing = this.health.get(key) || {
        store_id: storeId,
        provider,
        domain,
        operation,
        status: isSuccess ? 'HEALTHY' : 'DEGRADED'
      };

      if (isSuccess) {
        existing.status = 'HEALTHY';
        existing.last_success = new Date();
      } else {
        existing.status = 'DEGRADED';
        existing.last_failure = new Date();
      }
      this.health.set(key, existing);
      return [] as R[];
    }

    return [] as R[];
  }
}

describe('ACH-02 FencedDatabaseExecutor and Health/Control Fencing', () => {
  const storeId = 'store-test-uuid';
  const provider = 'zeiss';
  const domain = 'orders';
  const operation = 'discovery';
  const tokenInstanceA = 'token-instance-a-uuid';
  const tokenInstanceB = 'token-instance-b-uuid';

  let db: RealisticSimulatedDatabase;

  beforeEach(() => {
    db = new RealisticSimulatedDatabase();
  });

  const makeFencingContext = (token: string): LeaseFencingContext => ({
    storeId,
    provider,
    domain,
    operation,
    ownerToken: token
  });

  // Test 1 & 2: Demonstrating the original defect & proving rejection after fix
  it('1 & 3. Rejects write when lease is expired, even if owner token matches and no second instance exists', async () => {
    // Setup lease owned by Instance A, but EXPIRED 10 seconds ago
    db.setLease({
      store_id: storeId,
      provider,
      domain,
      operation,
      owner_token: tokenInstanceA,
      expires_at: new Date(Date.now() - 10000)
    });

    const fencedDbA = new FencedDatabaseExecutor(db, makeFencingContext(tokenInstanceA));

    // Must be rejected with StaleWriteError because lease is expired
    await expect(
      fencedDbA.query('INSERT INTO zeiss.orders (order_number, store_id) VALUES ($1, $2)', ['ORD-EXPIRED', storeId])
    ).rejects.toThrow(StaleWriteError);

    // Verify no orders were persisted
    expect(db.orders).toHaveLength(0);

    // Verify transaction was rolled back
    const tx = db.activeTransactions[0];
    expect(tx.rolledBack).toBe(true);
    expect(tx.committed).toBe(false);
  });

  // Test 4: Demonstrating rejection when second instance replaces token
  it('4. Rejects write when a second instance has replaced the lease token', async () => {
    // Setup lease acquired by Instance B
    db.setLease({
      store_id: storeId,
      provider,
      domain,
      operation,
      owner_token: tokenInstanceB,
      expires_at: new Date(Date.now() + 60000) // Valid TTL
    });

    // Instance A attempts to write
    const fencedDbA = new FencedDatabaseExecutor(db, makeFencingContext(tokenInstanceA));

    await expect(
      fencedDbA.query('INSERT INTO zeiss.orders (order_number, store_id) VALUES ($1, $2)', ['ORD-TOKEN-MISMATCH', storeId])
    ).rejects.toThrow(/mismatch/i);

    expect(db.orders).toHaveLength(0);
  });

  // Test 5: Demonstrating legitimate write with matching token and active lease
  it('5. Allows legitimate write when owner token matches and lease is valid', async () => {
    db.setLease({
      store_id: storeId,
      provider,
      domain,
      operation,
      owner_token: tokenInstanceA,
      expires_at: new Date(Date.now() + 60000) // Valid for 60s
    });

    const fencedDbA = new FencedDatabaseExecutor(db, makeFencingContext(tokenInstanceA));

    await fencedDbA.query('INSERT INTO zeiss.orders (order_number, store_id) VALUES ($1, $2)', ['ORD-LEGIT', storeId]);

    expect(db.orders).toHaveLength(1);
    expect(db.orders[0]).toEqual({ order_number: 'ORD-LEGIT', store_id: storeId });

    // Verify transaction was committed
    const tx = db.activeTransactions[0];
    expect(tx.committed).toBe(true);
    expect(tx.rolledBack).toBe(false);
  });

  // Test 6: Verifying same connection/transaction for validation and mutation
  it('6. Executes lease validation and data mutation within the exact same PostgreSQL transaction', async () => {
    db.setLease({
      store_id: storeId,
      provider,
      domain,
      operation,
      owner_token: tokenInstanceA,
      expires_at: new Date(Date.now() + 30000)
    });

    const fencedDb = new FencedDatabaseExecutor(db, makeFencingContext(tokenInstanceA));

    await fencedDb.transaction(async (txClient) => {
      await txClient.query('INSERT INTO zeiss.orders (order_number, store_id) VALUES ($1, $2)', ['ORD-TX-1', storeId]);
      await txClient.query('INSERT INTO zeiss.orders (order_number, store_id) VALUES ($1, $2)', ['ORD-TX-2', storeId]);
    });

    expect(db.activeTransactions).toHaveLength(1);
    const tx = db.activeTransactions[0];
    expect(tx.committed).toBe(true);
    expect(tx.queries[0]).toBe('BEGIN');
    // Validation must appear before mutations in the exact same transaction log
    expect(tx.queries.some(q => q.includes('FOR UPDATE'))).toBe(true);
    expect(tx.queries.filter(q => q.includes('INSERT INTO zeiss.orders'))).toHaveLength(2);
    expect(tx.queries[tx.queries.length - 1]).toBe('COMMIT');
    expect(db.orders).toEqual([
      { order_number: 'ORD-TX-1', store_id: storeId },
      { order_number: 'ORD-TX-2', store_id: storeId }
    ]);
  });

  // Test 7: Validating health/control writes under lease fencing vs administrative maintenance
  describe('7. Health/Control Fencing in StoreCompositionRoot', () => {
    const dummyStoreContext: StoreZeissContext = {
      storeId,
      organizationId: 'org-test-uuid',
      storeCode: 'store-test',
      orgCode: 'org-test',
      cnpj: '48310092000132',
      status: 'active',
      saowebCode: 'CN043229',
      zeissStoreCode: 'CN043229',
      countryId: '1',
      voucherUserId: 'voucher-user',
      finUserId: 'fin-user',
      apiKey: 'test-api-key'
    };

    it('fences health writes when StoreCompositionRoot is built with fencingContext for an active job', async () => {
      // Lease is expired
      db.setLease({
        store_id: storeId,
        provider,
        domain,
        operation,
        owner_token: tokenInstanceA,
        expires_at: new Date(Date.now() - 5000)
      });

      const deps = buildStoreCompositionDeps(
        db,
        dummyStoreContext,
        undefined,
        undefined,
        undefined,
        makeFencingContext(tokenInstanceA)
      );

      // Attempting to record health status under expired lease must fail with StaleWriteError
      await expect(deps.healthRepo.recordSuccess(provider, domain, operation)).rejects.toThrow(StaleWriteError);
      expect(db.health.size).toBe(0);

      // Now set lease to valid
      db.setLease({
        store_id: storeId,
        provider,
        domain,
        operation,
        owner_token: tokenInstanceA,
        expires_at: new Date(Date.now() + 60000)
      });

      // Valid lease allows health status recording
      await deps.healthRepo.recordSuccess(provider, domain, operation);
      const recorded = db.health.get(`${storeId}:${provider}:${domain}:${operation}`);
      expect(recorded?.status).toBe('HEALTHY');
    });

    it('preserves administrative and observability health writes outside the context of a job (no fencingContext)', async () => {
      // No lease exists at all in the database
      const deps = buildStoreCompositionDeps(
        db,
        dummyStoreContext,
        undefined,
        undefined,
        undefined,
        undefined // No fencing context - e.g. administrative check or monitoring probe
      );

      // Must succeed without throwing StaleWriteError
      await deps.healthRepo.recordFailure(provider, domain, operation);
      const recorded = db.health.get(`${storeId}:${provider}:${domain}:${operation}`);
      expect(recorded?.status).toBe('DEGRADED');
    });
  });
});
