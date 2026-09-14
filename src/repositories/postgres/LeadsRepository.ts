import { IDatabaseExecutor } from '../../config/db';
import { ILeadsRepository } from '../../contracts/repositories';
import { LeadRecord } from '../../contracts/types';

export class PgLeadsRepository implements ILeadsRepository {
  constructor(private db: IDatabaseExecutor) {}

  async upsertMany(campaignId: string, leads: LeadRecord[]): Promise<void> {
    if (leads.length === 0) return;

    await this.db.transaction(async (client) => {
      for (const lead of leads) {
        const query = `
          INSERT INTO zeiss.leads (campaign_id, lead_id, cpf_hmac, status, voucher_code, updated_at)
          VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
          ON CONFLICT (lead_id)
          DO UPDATE SET
            campaign_id = EXCLUDED.campaign_id,
            cpf_hmac = COALESCE(EXCLUDED.cpf_hmac, zeiss.leads.cpf_hmac),
            status = EXCLUDED.status,
            voucher_code = EXCLUDED.voucher_code,
            updated_at = CURRENT_TIMESTAMP
        `;
        await client.query(query, [
          campaignId,
          lead.lead_id,
          lead.cpf_hmac,
          lead.status,
          lead.voucher_code
        ]);
      }
    });
  }

  async upsertRedeemedMany(campaignId: string, leads: LeadRecord[]): Promise<void> {
    if (leads.length === 0) return;

    await this.db.transaction(async (client) => {
      for (const lead of leads) {
        const query = `
          INSERT INTO zeiss.leads (campaign_id, lead_id, cpf_hmac, status, voucher_code, updated_at)
          VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
          ON CONFLICT (lead_id)
          DO UPDATE SET
            campaign_id = EXCLUDED.campaign_id,
            cpf_hmac = COALESCE(EXCLUDED.cpf_hmac, zeiss.leads.cpf_hmac),
            status = EXCLUDED.status,
            voucher_code = EXCLUDED.voucher_code,
            updated_at = CURRENT_TIMESTAMP
        `;
        await client.query(query, [
          campaignId,
          lead.lead_id,
          lead.cpf_hmac,
          lead.status,
          lead.voucher_code
        ]);
      }
    });
  }
}
