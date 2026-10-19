import { PgOrdersRepository } from '../../../../src/repositories/postgres/OrdersRepository';
import { IDatabaseExecutor } from '../../../../src/config/db';
import { OrderRecord } from '../../../../src/contracts/types';

describe('PgOrdersRepository Unit Tests (ML-003)', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let clientQueryMock: jest.Mock;

  beforeEach(() => {
    clientQueryMock = jest.fn().mockResolvedValue([]);
    mockDb = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (callback) => {
        return await callback({ query: clientQueryMock } as any);
      })
    };
  });

  const sampleOrder: OrderRecord = {
    order_number: 'ZEISS-1001',
    os_number: 'OS-55',
    status: 'IN_PRODUCTION',
    codsit: '02',
    entry_date: '2026-06-01',
    expected_date: '2026-06-10'
  };

  describe('Scoped Upsert (with store_id)', () => {
    it('should inject store_id into insert and protect historical/cross-store records in ON CONFLICT', async () => {
      const repo = new PgOrdersRepository(mockDb, 'store-uuid-1');

      await repo.upsertMany([sampleOrder]);

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(clientQueryMock).toHaveBeenCalledTimes(1);

      const [sql, params] = clientQueryMock.mock.calls[0];

      // Verifies SQL incorporates protection clauses
      expect(sql).toContain('INSERT INTO zeiss.orders');
      expect(sql).toContain('ON CONFLICT (order_number)');
      expect(sql).toContain('store_id = zeiss.orders.store_id');
      expect(sql).toContain('WHEN zeiss.orders.store_id = EXCLUDED.store_id THEN EXCLUDED.os_number');
      expect(sql).toContain('ELSE zeiss.orders.os_number');

      // Verifies params
      expect(params).toEqual([
        sampleOrder.order_number,
        sampleOrder.os_number,
        sampleOrder.status,
        sampleOrder.codsit,
        sampleOrder.entry_date,
        sampleOrder.expected_date,
        'store-uuid-1'
      ]);
    });
  });

  describe('Legacy Upsert (without store_id)', () => {
    it('should omit store_id from insert and update only when store_id IS NULL in ON CONFLICT', async () => {
      const repo = new PgOrdersRepository(mockDb); // Unscoped

      await repo.upsertMany([sampleOrder]);

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(clientQueryMock).toHaveBeenCalledTimes(1);

      const [sql, params] = clientQueryMock.mock.calls[0];

      expect(sql).toContain('INSERT INTO zeiss.orders (order_number, os_number, status, codsit, entry_date, expected_date, updated_at)');
      expect(sql).toContain('WHEN zeiss.orders.store_id IS NULL THEN EXCLUDED.os_number');
      expect(sql).toContain('ELSE zeiss.orders.os_number');

      expect(params).toEqual([
        sampleOrder.order_number,
        sampleOrder.os_number,
        sampleOrder.status,
        sampleOrder.codsit,
        sampleOrder.entry_date,
        sampleOrder.expected_date
      ]);
    });
  });

  describe('Queries Scoped to Store ID', () => {
    it('should filter findOrdersWithoutDetail by store_id when configured', async () => {
      const repo = new PgOrdersRepository(mockDb, 'store-uuid-2');
      await repo.findOrdersWithoutDetail();

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('AND o.store_id = $1'),
        ['store-uuid-2']
      );
    });

    it('should omit store_id filter in findOrdersWithoutDetail when unscoped', async () => {
      const repo = new PgOrdersRepository(mockDb);
      await repo.findOrdersWithoutDetail();

      const [sql, params] = mockDb.query.mock.calls[0];
      expect(sql).not.toContain('AND o.store_id = $1');
      expect(params).toEqual([]);
    });

    it('should filter findActiveOrders by store_id when configured', async () => {
      const repo = new PgOrdersRepository(mockDb, 'store-uuid-3');
      await repo.findActiveOrders();

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE o.store_id = $1'),
        ['store-uuid-3']
      );
    });
  });
});
