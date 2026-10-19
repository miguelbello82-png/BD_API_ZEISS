import { PgStoreSyncStateRepository } from '../../../../src/repositories/postgres/StoreSyncStateRepository';
import { PgStoreSyncPolicyRepository } from '../../../../src/repositories/postgres/StoreSyncPolicyRepository';
import { PgStoreSyncLeaseRepository } from '../../../../src/repositories/postgres/StoreSyncLeaseRepository';
import { PgStoreProviderHealthRepository } from '../../../../src/repositories/postgres/StoreProviderHealthRepository';
import { IDatabaseExecutor } from '../../../../src/config/db';

describe('Multi-Store Sync Repositories Unit Tests', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  const storeA = '11111111-1111-1111-1111-111111111111';
  const storeB = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
      transaction: jest.fn(),
    } as any;
  });

  describe('PgStoreSyncStateRepository', () => {
    it('isolates state queries and writes by store_id', async () => {
      const repoA = new PgStoreSyncStateRepository(mockDb, storeA);
      const repoB = new PgStoreSyncStateRepository(mockDb, storeB);

      mockDb.query.mockResolvedValueOnce([
        { provider: 'zeiss', domain: 'orders', operation: 'discovery', last_sync: new Date(), cursor_value: '{"cursor":1}' }
      ]);

      const stateA = await repoA.findByKey('zeiss', 'orders', 'discovery');
      expect(stateA?.cursor_value).toBe('{"cursor":1}');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('integration.store_sync_state'),
        [storeA, 'zeiss', 'orders', 'discovery']
      );

      await repoB.upsert({
        provider: 'zeiss',
        domain: 'orders',
        operation: 'discovery',
        last_sync: new Date(),
        cursor_value: '{"cursor":2}'
      });

      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringContaining('INSERT INTO integration.store_sync_state'),
        expect.arrayContaining([storeB, 'zeiss', 'orders', 'discovery'])
      );
    });
  });

  describe('PgStoreSyncPolicyRepository', () => {
    it('queries store policies with store_id filtering', async () => {
      const repoA = new PgStoreSyncPolicyRepository(mockDb, storeA);
      mockDb.query.mockResolvedValueOnce([
        { provider: 'zeiss', domain: 'orders', operation: 'discovery', enabled: true, interval_seconds: 3600 }
      ]);

      const policies = await repoA.findEnabledByProvider('zeiss');
      expect(policies.length).toBe(1);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM integration.store_sync_policies'),
        [storeA, 'zeiss']
      );
    });
  });

  describe('PgStoreSyncLeaseRepository', () => {
    it('attempts lease acquisition with store_id in composite key', async () => {
      const repoA = new PgStoreSyncLeaseRepository(mockDb, storeA);
      mockDb.query.mockResolvedValueOnce([{ store_id: storeA, acquired: true }]);

      const result = await repoA.tryAcquire('zeiss', 'orders', 'discovery', 'worker-1', 600);
      expect(result.acquired).toBe(true);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO integration.store_sync_leases'),
        [storeA, 'zeiss', 'orders', 'discovery', 'worker-1', 600]
      );
    });

    it('releases lease checking store_id and owner_token', async () => {
      const repoA = new PgStoreSyncLeaseRepository(mockDb, storeA);
      mockDb.query.mockResolvedValueOnce([]);

      await repoA.release('zeiss', 'orders', 'discovery', 'worker-1');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM integration.store_sync_leases'),
        [storeA, 'zeiss', 'orders', 'discovery', 'worker-1']
      );
    });
  });

  describe('PgStoreProviderHealthRepository', () => {
    it('records health events isolated by store_id', async () => {
      const repoA = new PgStoreProviderHealthRepository(mockDb, storeA);
      mockDb.query.mockResolvedValueOnce([]);

      await repoA.recordSuccess('zeiss', 'orders', 'discovery');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO integration.store_provider_health'),
        [storeA, 'zeiss', 'orders', 'discovery']
      );

      await repoA.recordFailure('zeiss', 'orders', 'discovery');
      expect(mockDb.query).toHaveBeenLastCalledWith(
        expect.stringContaining('INSERT INTO integration.store_provider_health'),
        [storeA, 'zeiss', 'orders', 'discovery']
      );
    });
  });
});
