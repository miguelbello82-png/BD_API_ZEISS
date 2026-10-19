import { IDatabaseExecutor } from '../../config/db';
import { IOrdersRepository } from '../../contracts/repositories';
import { OrderRecord, OrderCandidate } from '../../contracts/types';

export class PgOrdersRepository implements IOrdersRepository {
  constructor(
    private db: IDatabaseExecutor,
    private storeId?: string
  ) {}

  getStoreId(): string | undefined {
    return this.storeId;
  }

  async upsertMany(orders: OrderRecord[], storeIdOverride?: string): Promise<void> {
    if (orders.length === 0) return;

    const targetStoreId = storeIdOverride !== undefined ? storeIdOverride : (this.storeId || null);

    // Execute in transaction to ensure atomicity
    await this.db.transaction(async (client) => {
      for (const order of orders) {
        if (targetStoreId) {
          const query = `
            INSERT INTO zeiss.orders (order_number, os_number, status, codsit, entry_date, expected_date, store_id, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
            ON CONFLICT (order_number)
            DO UPDATE SET
              os_number = CASE 
                WHEN zeiss.orders.store_id = EXCLUDED.store_id THEN EXCLUDED.os_number 
                ELSE zeiss.orders.os_number 
              END,
              status = CASE 
                WHEN zeiss.orders.store_id = EXCLUDED.store_id THEN EXCLUDED.status 
                ELSE zeiss.orders.status 
              END,
              codsit = CASE 
                WHEN zeiss.orders.store_id = EXCLUDED.store_id THEN EXCLUDED.codsit 
                ELSE zeiss.orders.codsit 
              END,
              entry_date = CASE 
                WHEN zeiss.orders.store_id = EXCLUDED.store_id THEN COALESCE(zeiss.orders.entry_date, EXCLUDED.entry_date)
                ELSE zeiss.orders.entry_date 
              END,
              expected_date = CASE 
                WHEN zeiss.orders.store_id = EXCLUDED.store_id THEN COALESCE(zeiss.orders.expected_date, EXCLUDED.expected_date)
                ELSE zeiss.orders.expected_date 
              END,
              store_id = zeiss.orders.store_id,
              updated_at = CASE 
                WHEN zeiss.orders.store_id = EXCLUDED.store_id THEN CURRENT_TIMESTAMP 
                ELSE zeiss.orders.updated_at 
              END
          `;
          await client.query(query, [
            order.order_number,
            order.os_number || null,
            order.status || null,
            order.codsit || null,
            order.entry_date || null,
            order.expected_date || null,
            targetStoreId
          ]);
        } else {
          const query = `
            INSERT INTO zeiss.orders (order_number, os_number, status, codsit, entry_date, expected_date, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            ON CONFLICT (order_number)
            DO UPDATE SET
              os_number = CASE 
                WHEN zeiss.orders.store_id IS NULL THEN EXCLUDED.os_number 
                ELSE zeiss.orders.os_number 
              END,
              status = CASE 
                WHEN zeiss.orders.store_id IS NULL THEN EXCLUDED.status 
                ELSE zeiss.orders.status 
              END,
              codsit = CASE 
                WHEN zeiss.orders.store_id IS NULL THEN EXCLUDED.codsit 
                ELSE zeiss.orders.codsit 
              END,
              entry_date = CASE 
                WHEN zeiss.orders.store_id IS NULL THEN COALESCE(zeiss.orders.entry_date, EXCLUDED.entry_date) 
                ELSE zeiss.orders.entry_date 
              END,
              expected_date = CASE 
                WHEN zeiss.orders.store_id IS NULL THEN COALESCE(zeiss.orders.expected_date, EXCLUDED.expected_date) 
                ELSE zeiss.orders.expected_date 
              END,
              updated_at = CASE 
                WHEN zeiss.orders.store_id IS NULL THEN CURRENT_TIMESTAMP 
                ELSE zeiss.orders.updated_at 
              END
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
      }
    });
  }

  async findOrdersWithoutDetail(storeIdOverride?: string): Promise<OrderCandidate[]> {
    const targetStoreId = storeIdOverride !== undefined ? storeIdOverride : this.storeId;
    const query = `
      SELECT o.id as order_id, o.order_number, o.status as raw_status, o.codsit as raw_codsit, NULL as detail_status
      FROM zeiss.orders o
      LEFT JOIN zeiss.order_details od ON o.id = od.order_id
      WHERE od.id IS NULL
      ${targetStoreId ? 'AND o.store_id = $1' : ''}
    `;
    const params = targetStoreId ? [targetStoreId] : [];
    const result = await this.db.query(query, params);
    return result.map(row => ({
      order_id: String(row.order_id),
      order_number: String(row.order_number),
      raw_status: row.raw_status ? String(row.raw_status) : null,
      raw_codsit: row.raw_codsit ? String(row.raw_codsit) : null,
      detail_status: null
    }));
  }

  async findActiveOrders(storeIdOverride?: string): Promise<OrderCandidate[]> {
    const targetStoreId = storeIdOverride !== undefined ? storeIdOverride : this.storeId;
    const query = `
      SELECT
        o.id as order_id,
        o.order_number,
        o.status as raw_status,
        o.codsit as raw_codsit,
        COALESCE(od.raw_status, od.raw_situacao) as detail_status
      FROM zeiss.orders o
      LEFT JOIN zeiss.order_details od ON o.id = od.order_id
      ${targetStoreId ? 'WHERE o.store_id = $1' : ''}
    `;
    const params = targetStoreId ? [targetStoreId] : [];
    const result = await this.db.query(query, params);
    return result.map(row => ({
      order_id: String(row.order_id),
      order_number: String(row.order_number),
      raw_status: row.raw_status ? String(row.raw_status) : null,
      raw_codsit: row.raw_codsit ? String(row.raw_codsit) : null,
      detail_status: row.detail_status ? String(row.detail_status) : null
    }));
  }
}
