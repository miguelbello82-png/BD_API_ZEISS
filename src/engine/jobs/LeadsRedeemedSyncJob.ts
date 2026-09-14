import { IJob, JobContext, JobResult } from '../JobRegistry';
import { ILogger } from '../../observability/Logger';
import { ILeadsProvider } from '../../contracts/providers';
import { ISyncStateRepository, ILeadsRepository } from '../../contracts/repositories';
import { LeadMapper } from '../Mappers';

export class LeadsRedeemedSyncJob implements IJob {
  private static readonly COMPONENT = 'LeadsRedeemedSyncJob';

  constructor(
    private provider: ILeadsProvider,
    private stateRepo: ISyncStateRepository,
    private leadsRepo: ILeadsRepository,
    private logger: ILogger
  ) {}

  async execute(context: JobContext): Promise<JobResult> {
    const { abortSignal } = context;
    this.logger.info(LeadsRedeemedSyncJob.COMPONENT, 'Starting redeemed leads sync');

    let errors = 0;
    let synced = 0;

    try {
      const camState = await this.stateRepo.findByKey('zeiss', 'campaigns', 'sync');
      if (!camState || !camState.cursor_value) {
        throw new Error('BOOTSTRAP_REQUIRED: Missing CAM-001 successful snapshot in sync_state');
      }
      
      let activeCampaigns: string[] = [];
      try {
        const cursorObj = JSON.parse(camState.cursor_value);
        if (Array.isArray(cursorObj.activeCampaignIds)) {
          activeCampaigns = cursorObj.activeCampaignIds;
        } else {
          throw new Error('Invalid cursor_value structure');
        }
      } catch (e) {
        throw new Error('BOOTSTRAP_REQUIRED: Malformed CAM-001 snapshot in sync_state');
      }
      
      for (const campaignId of activeCampaigns) {
        if (abortSignal.aborted) break;

        try {
          // Assuming provider exposes getRedeemedLeads
          const rawLeads = await this.provider.getRedeemedLeads(campaignId, abortSignal);
          const normalized = rawLeads.map(raw => {
            try {
              return LeadMapper.normalize(raw);
            } catch (err) {
              errors++;
              return null;
            }
          }).filter(l => l !== null);
          
          await this.leadsRepo.upsertRedeemedMany(campaignId, normalized);
          synced += normalized.length;
        } catch (err) {
          errors++;
          this.logger.error(LeadsRedeemedSyncJob.COMPONENT, `Failed to sync redeemed leads for campaign ${campaignId}`, { error: String(err) });
        }
      }
    } catch (err) {
      if (abortSignal.aborted) {
        return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
      }
      return { success: false, retryable: true, error: err instanceof Error ? err : new Error(String(err)) };
    }

    if (abortSignal.aborted) {
      return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
    }

    return {
      success: errors === 0,
      retryable: true,
      metrics: {
        synced,
        errors
      }
    };
  }
}
