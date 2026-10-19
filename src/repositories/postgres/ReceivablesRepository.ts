import { IDatabaseExecutor } from '../../config/db';
import { IReceivablesRepository } from '../../contracts/repositories';
import { ReceivableRecord } from '../../contracts/types';

export class PgReceivablesRepository implements IReceivablesRepository {
  constructor(
    private db: IDatabaseExecutor,
    private storeId?: string
  ) {}

  getStoreId(): string | undefined {
    return this.storeId;
  }

  async upsertMany(receivables: ReceivableRecord[], storeIdOverride?: string): Promise<void> {
    if (receivables.length === 0) return;

    const targetStoreId = storeIdOverride !== undefined ? storeIdOverride : (this.storeId || null);

    await this.db.transaction(async (client) => {
      for (const receivable of receivables) {
        const query = `
          INSERT INTO zeiss.receivables (boleto_number, fiscal_reference, emission_date, due_date, amount, status, store_id, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
          ON CONFLICT (boleto_number)
          DO UPDATE SET
            fiscal_reference = EXCLUDED.fiscal_reference,
            emission_date = EXCLUDED.emission_date,
            due_date = EXCLUDED.due_date,
            amount = EXCLUDED.amount,
            status = EXCLUDED.status,
            store_id = COALESCE(zeiss.receivables.store_id, EXCLUDED.store_id),
            updated_at = CURRENT_TIMESTAMP
        `;
        await client.query(query, [
          receivable.boleto_number,
          receivable.fiscal_reference,
          receivable.emission_date ? new Date(receivable.emission_date) : null,
          receivable.due_date ? new Date(receivable.due_date) : null,
          receivable.amount,
          receivable.status,
          targetStoreId
        ]);
      }
    });
  }
}
