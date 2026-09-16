import { IDatabaseExecutor } from '../../config/db';
import { IOrderDetailsRepository } from '../../contracts/repositories';
import { OrderDetailRecord } from '../../contracts/types';

export class PgOrderDetailsRepository implements IOrderDetailsRepository {
  constructor(private db: IDatabaseExecutor) {}

  async upsert(orderNumber: string, detail: OrderDetailRecord): Promise<void> {
    await this.db.transaction(async (client) => {
      // Find order_id
      const orderQuery = `SELECT id FROM zeiss.orders WHERE order_number = $1`;
      const orders = await client.query(orderQuery, [orderNumber]);
      if (orders.length === 0) {
        throw new Error(`Order ${orderNumber} not found when upserting detail`);
      }
      const orderId = orders[0].id;

      // Update parent order dates (using COALESCE so we never erase an existing date)
      if (detail.entry_date || detail.expected_date) {
        const updateDatesQuery = `
          UPDATE zeiss.orders
          SET
            entry_date = COALESCE(entry_date, $1),
            expected_date = COALESCE($2, expected_date)
          WHERE id = $3
        `;
        await client.query(updateDatesQuery, [detail.entry_date || null, detail.expected_date || null, orderId]);
      }

      // Upsert detail (using order_id as foreign key constraint, assuming unique on order_id)
      const detailQuery = `
        INSERT INTO zeiss.order_details (order_id, raw_status, raw_situacao, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (order_id)
        DO UPDATE SET
          raw_status = EXCLUDED.raw_status,
          raw_situacao = EXCLUDED.raw_situacao,
          updated_at = CURRENT_TIMESTAMP
      `;
      await client.query(detailQuery, [orderId, detail.status, detail.situacao]);

      // Upsert invoices
      if (detail.invoices && detail.invoices.length > 0) {
        for (const invoice of detail.invoices) {
          const invoiceQuery = `
            INSERT INTO zeiss.fiscal_documents (order_id, nf_number, nf_series, created_at)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (order_id, nf_number)
            DO UPDATE SET nf_series = EXCLUDED.nf_series
          `;
          await client.query(invoiceQuery, [orderId, invoice.number, invoice.series]);
        }
      }
    });
  }

  async exists(orderNumber: string): Promise<boolean> {
    const query = `
      SELECT 1
      FROM zeiss.order_details od
      JOIN zeiss.orders o ON o.id = od.order_id
      WHERE o.order_number = $1
    `;
    const result = await this.db.query(query, [orderNumber]);
    return result.length > 0;
  }
}
