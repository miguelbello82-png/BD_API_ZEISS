import { IJob, JobContext, JobResult } from '../JobRegistry';
import { ILogger } from '../../observability/Logger';
import { ICampaignsProvider } from '../../contracts/providers';
import { ICampaignsRepository } from '../../contracts/repositories';
import { CampaignMapper } from '../Mappers';

export class CampaignsSyncJob implements IJob {
  private static readonly COMPONENT = 'CampaignsSyncJob';

  constructor(
    private provider: ICampaignsProvider,
    private repo: ICampaignsRepository,
    private logger: ILogger
  ) {}

  async execute(context: JobContext): Promise<JobResult> {
    const { abortSignal } = context;
    this.logger.info(CampaignsSyncJob.COMPONENT, 'Starting campaigns sync');

    let errors = 0;
    let synced = 0;
    let firstError: Error | undefined;

    let activeCampaignIds: string[] = [];

    try {
      // Assuming getCampaigns returns a raw array
      const rawCampaigns = await this.provider.getCampaigns(abortSignal);
      const normalized = rawCampaigns.map(raw => {
        try {
          return CampaignMapper.normalize(raw);
        } catch (err) {
          errors++;
          if (!firstError) {
            firstError = err instanceof Error ? err : new Error(String(err));
          }
          return null;
        }
      }).filter(c => c !== null);

      if (abortSignal.aborted) {
        return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
      }

      await this.repo.upsertMany(normalized);
      synced = normalized.length;
      activeCampaignIds = normalized.map(c => c.campaign_id);
    } catch (err) {
      if (abortSignal.aborted) {
        return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
      }
      return { success: false, retryable: true, error: err instanceof Error ? err : new Error(String(err)) };
    }

    if (abortSignal.aborted) {
      return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
    }

    // Sort to canonicalize snapshot
    activeCampaignIds.sort();

    return {
      success: errors === 0,
      retryable: true,
      error: firstError,
      cursorValue: JSON.stringify({ activeCampaignIds }),
      metrics: {
        synced,
        errors
      }
    };
  }
}
