import { IDatabaseExecutor } from '../../config/db';
import { IOrdersRepository } from '../../contracts/repositories';
import { OrderRecord, OrderCandidate } from '../../contracts/types';

export class PgOrdersRepository implements IOrdersRepository {
  constructor(private db: IDatabaseExecutor) {}

  async upsertMany(orders: OrderRecord[]): Promise<void> {
    if (orders.length === 0) return;

    // Execute in transaction to ensure atomicity
    await this.db.transaction(async (client) => {
      for (const order of orders) {
        const query = `
          INSERT INTO zeiss.orders (order_number, os_number, status, codsit, entry_date, expected_date, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
          ON CONFLICT (order_number)
          DO UPDATE SET
            os_number = EXCLUDED.os_number,
            status = EXCLUDED.status,
            codsit = EXCLUDED.codsit,
            entry_date = COALESCE(EXCLUDED.entry_date, zeiss.orders.entry_date),
            expected_date = COALESCE(EXCLUDED.expected_date, zeiss.orders.expected_date),
            updated_at = CURRENT_TIMESTAMP
        `;
        await client.query(query, [
          order.order_number,
          order.os_number || null,
          order.status || null,
          order.codsit || null,
          order.entry_date || null,
          order.expected_date || null
        ]);
      }
    });
  }

  async findOrdersWithoutDetail(): Promise<OrderCandidate[]> {
    const query = `
      SELECT o.id as order_id, o.order_number, o.status as raw_status, o.codsit as raw_codsit, NULL as detail_status
      FROM zeiss.orders o
      LEFT JOIN zeiss.order_details od ON o.id = od.order_id
      WHERE od.id IS NULL
    `;
    const result = await this.db.query(query);
    return result.map(row => ({
      order_id: String(row.order_id),
      order_number: String(row.order_number),
      raw_status: row.raw_status ? String(row.raw_status) : null,
      raw_codsit: row.raw_codsit ? String(row.raw_codsit) : null,
      detail_status: null
    }));
  }

  async findActiveOrders(): Promise<OrderCandidate[]> {
    // In PostgreSQL we select all and let the TS logic filter mutable/immutable using the Classifier.
    // Optimization: could filter via SQL if we wanted to mirror the mapping in SQL, but for now we fetch all
    // and rely on engine to filter.
    const query = `
      SELECT
        o.id as order_id,
        o.order_number,
        o.status as raw_status,
        o.codsit as raw_codsit,
        COALESCE(od.raw_status, od.raw_situacao) as detail_status
      FROM zeiss.orders o
      LEFT JOIN zeiss.order_details od ON o.id = od.order_id
    `;
    const result = await this.db.query(query);
    return result.map(row => ({
      order_id: String(row.order_id),
      order_number: String(row.order_number),
      raw_status: row.raw_status ? String(row.raw_status) : null,
      raw_codsit: row.raw_codsit ? String(row.raw_codsit) : null,
      detail_status: row.detail_status ? String(row.detail_status) : null
    }));
  }
}
