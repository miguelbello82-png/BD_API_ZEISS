import { IDatabaseExecutor } from '../../config/db';
import { ILeadsRepository } from '../../contracts/repositories';
import { LeadRecord } from '../../contracts/types';

export class PgLeadsRepository implements ILeadsRepository {
  constructor(
    private db: IDatabaseExecutor,
    private storeId?: string
  ) {}

  getStoreId(): string | undefined {
    return this.storeId;
  }

  async upsertMany(campaignId: string, leads: LeadRecord[], storeIdOverride?: string): Promise<void> {
    if (leads.length === 0) return;

    const targetStoreId = storeIdOverride !== undefined ? storeIdOverride : (this.storeId || null);

    await this.db.transaction(async (client) => {
      for (const lead of leads) {
        if (targetStoreId) {
          const query = `
            INSERT INTO zeiss.leads (campaign_id, email_hmac, voucher_code, status, store_id, updated_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (campaign_id, voucher_code, email_hmac)
            DO UPDATE SET
              status = CASE
                WHEN zeiss.leads.status = 'Resgatado' THEN zeiss.leads.status
                ELSE EXCLUDED.status
              END,
              store_id = COALESCE(zeiss.leads.store_id, EXCLUDED.store_id),
              updated_at = CURRENT_TIMESTAMP
          `;
          await client.query(query, [
            campaignId,
            lead.email_hmac,
            lead.voucher_code,
            lead.status,
            targetStoreId
          ]);
        } else {
          const query = `
            INSERT INTO zeiss.leads (campaign_id, email_hmac, voucher_code, status, updated_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (campaign_id, voucher_code, email_hmac)
            DO UPDATE SET
              status = CASE
                WHEN zeiss.leads.status = 'Resgatado' THEN zeiss.leads.status
                ELSE EXCLUDED.status
              END,
              updated_at = CURRENT_TIMESTAMP
          `;
          await client.query(query, [
            campaignId,
            lead.email_hmac,
            lead.voucher_code,
            lead.status
          ]);
        }
      }
    });
  }

  async upsertRedeemedMany(campaignId: string, leads: LeadRecord[], storeIdOverride?: string): Promise<void> {
    if (leads.length === 0) return;

    const targetStoreId = storeIdOverride !== undefined ? storeIdOverride : (this.storeId || null);

    await this.db.transaction(async (client) => {
      for (const lead of leads) {
        if (targetStoreId) {
          const query = `
            INSERT INTO zeiss.leads (campaign_id, email_hmac, voucher_code, status, store_id, updated_at)
            VALUES ($1, $2, $3, 'Resgatado', $4, CURRENT_TIMESTAMP)
            ON CONFLICT (campaign_id, voucher_code, email_hmac)
            DO UPDATE SET
              status = 'Resgatado',
              store_id = COALESCE(zeiss.leads.store_id, EXCLUDED.store_id),
              updated_at = CURRENT_TIMESTAMP
          `;
          await client.query(query, [
            campaignId,
            lead.email_hmac,
            lead.voucher_code,
            targetStoreId
          ]);
        } else {
          const query = `
            INSERT INTO zeiss.leads (campaign_id, email_hmac, voucher_code, status, updated_at)
            VALUES ($1, $2, $3, 'Resgatado', CURRENT_TIMESTAMP)
            ON CONFLICT (campaign_id, voucher_code, email_hmac)
            DO UPDATE SET
              status = 'Resgatado',
              updated_at = CURRENT_TIMESTAMP
          `;
          await client.query(query, [
            campaignId,
            lead.email_hmac,
            lead.voucher_code
          ]);
        }
      }
    });
  }
}
