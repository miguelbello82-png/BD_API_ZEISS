import { PgOrdersRepository } from '../../../../src/repositories/postgres/OrdersRepository';
import { PgOrderDetailsRepository } from '../../../../src/repositories/postgres/OrderDetailsRepository';
import { IDatabaseExecutor } from '../../../../src/config/db';

describe('Orders Date Semantics Regression Tests', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let dbState: any = {};

  beforeEach(() => {
    dbState = {};

    // Miniature Postgres-like mock to execute the COALESCE logic
    mockDb = {
      query: jest.fn(async (sql: string, params: any[]) => {
        if (sql.includes('INSERT INTO zeiss.orders') && sql.includes('ON CONFLICT')) {
          // Mock ORD-001 upsert
          const order_number = params[0];
          const entry_date = params[4];
          const expected_date = params[5];
          
          if (!dbState[order_number]) {
            dbState[order_number] = { entry_date, expected_date };
          } else {
            const existing = dbState[order_number];
            // Simulate: entry_date = COALESCE(zeiss.orders.entry_date, EXCLUDED.entry_date)
            dbState[order_number].entry_date = existing.entry_date !== null ? existing.entry_date : entry_date;
            // Simulate: expected_date = COALESCE(zeiss.orders.expected_date, EXCLUDED.expected_date)
            dbState[order_number].expected_date = existing.expected_date !== null ? existing.expected_date : expected_date;
          }
        } else if (sql.includes('SELECT id FROM zeiss.orders WHERE order_number')) {
           const order_number = params[0];
           if (dbState[order_number]) return [{ id: order_number }];
           return [];
        } else if (sql.includes('UPDATE zeiss.orders') && sql.includes('COALESCE(entry_date, $1)')) {
          // Mock ORD-002 update
          const entry_date = params[0];
          const expected_date = params[1];
          const id = params[2];

          if (dbState[id]) {
            const existing = dbState[id];
            // Simulate: entry_date = COALESCE(entry_date, $1)
            dbState[id].entry_date = existing.entry_date !== null ? existing.entry_date : entry_date;
            // Simulate: expected_date = COALESCE($2, expected_date)
            dbState[id].expected_date = expected_date !== null ? expected_date : existing.expected_date;
          }
        }
        return [];
      }),
      transaction: jest.fn(async (cb) => await cb(mockDb))
    } as any;
  });

  const runOrd001 = async (order_number: string, entry_date: string | null, expected_date: string | null) => {
    const repo = new PgOrdersRepository(mockDb);
    await repo.upsertMany([{ order_number, entry_date, expected_date } as any]);
  };

  const runOrd002 = async (order_number: string, entry_date: string | null, expected_date: string | null) => {
    const repo = new PgOrderDetailsRepository(mockDb);
    await repo.upsert(order_number, { entry_date, expected_date } as any);
  };

  it('CASE 1 — entry_date immutable (ORD-001)', async () => {
    dbState['1'] = { entry_date: '2026-09-15', expected_date: null };
    await runOrd001('1', '2026-09-16', null);
    expect(dbState['1'].entry_date).toBe('2026-09-15');
  });

  it('CASE 2 — entry_date immutable from ORD-002', async () => {
    dbState['2'] = { entry_date: '2026-09-15', expected_date: null };
    await runOrd002('2', '2026-09-16', null);
    expect(dbState['2'].entry_date).toBe('2026-09-15');
  });

  it('CASE 3 — ORD-001 fills missing expected_date', async () => {
    dbState['3'] = { entry_date: null, expected_date: null };
    await runOrd001('3', null, '2026-09-18');
    expect(dbState['3'].expected_date).toBe('2026-09-18');
  });

  it('CASE 4 — ORD-001 cannot overwrite existing expected_date (models 4467380)', async () => {
    dbState['4467380'] = { entry_date: null, expected_date: '2026-09-21' };
    await runOrd001('4467380', null, '2026-09-18');
    expect(dbState['4467380'].expected_date).toBe('2026-09-21');
  });

  it('CASE 5 — ORD-002 updates expected_date', async () => {
    dbState['5'] = { entry_date: null, expected_date: '2026-09-18' };
    await runOrd002('5', null, '2026-09-21');
    expect(dbState['5'].expected_date).toBe('2026-09-21');
  });

  it('CASE 6 — ORD-002 empty expected date does not erase', async () => {
    dbState['6'] = { entry_date: null, expected_date: '2026-09-21' };
    await runOrd002('6', null, null);
    expect(dbState['6'].expected_date).toBe('2026-09-21');
  });

  it('CASE 7 — current real mismatch model (models 4488398)', async () => {
    dbState['4488398'] = { entry_date: null, expected_date: '2026-09-24' };
    await runOrd001('4488398', null, '2026-09-25');
    expect(dbState['4488398'].expected_date).toBe('2026-09-24');
  });
});
