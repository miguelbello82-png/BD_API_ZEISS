import { IDatabaseExecutor } from '../../config/db';
import { ICampaignsRepository } from '../../contracts/repositories';
import { CampaignRecord } from '../../contracts/types';

export class PgCampaignsRepository implements ICampaignsRepository {
  constructor(
    private db: IDatabaseExecutor,
    private storeId?: string
  ) {}

  getStoreId(): string | undefined {
    return this.storeId;
  }

  async upsertMany(campaigns: CampaignRecord[], storeIdOverride?: string): Promise<void> {
    if (campaigns.length === 0) return;

    const targetStoreId = storeIdOverride !== undefined ? storeIdOverride : this.storeId;

    await this.db.transaction(async (client) => {
      for (const campaign of campaigns) {
        // 1. Upsert global campaign catalog
        const query = `
          INSERT INTO zeiss.campaigns (campaign_id, title, slogan, description, start_date, end_date, status, aceite, incentive_type, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
          ON CONFLICT (campaign_id)
          DO UPDATE SET
            title = EXCLUDED.title,
            slogan = EXCLUDED.slogan,
            description = EXCLUDED.description,
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            status = EXCLUDED.status,
            aceite = EXCLUDED.aceite,
            incentive_type = EXCLUDED.incentive_type,
            updated_at = CURRENT_TIMESTAMP
        `;
        await client.query(query, [
          campaign.campaign_id,
          campaign.title,
          campaign.slogan,
          campaign.description,
          campaign.start_date ? new Date(campaign.start_date) : null,
          campaign.end_date ? new Date(campaign.end_date) : null,
          campaign.status,
          campaign.aceite,
          campaign.incentive_type
        ]);

        // 2. If store context exists, upsert store-specific campaign status/adhesion in zeiss.store_campaigns
        if (targetStoreId) {
          const storeCampaignQuery = `
            INSERT INTO zeiss.store_campaigns (store_id, campaign_id, status, aceite, updated_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (store_id, campaign_id)
            DO UPDATE SET
              status = EXCLUDED.status,
              aceite = EXCLUDED.aceite,
              updated_at = CURRENT_TIMESTAMP
          `;
          await client.query(storeCampaignQuery, [
            targetStoreId,
            campaign.campaign_id,
            campaign.status,
            campaign.aceite
          ]);
        }
      }
    });
  }
}
