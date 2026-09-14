import { IJob, JobContext, JobResult } from '../JobRegistry';
import { ILogger } from '../../observability/Logger';
import { IProductsProvider } from '../../contracts/providers';
import { IProductsRepository } from '../../contracts/repositories';
import { ProductMapper } from '../Mappers';

export class ProductsSyncJob implements IJob {
  private static readonly COMPONENT = 'ProductsSyncJob';

  constructor(
    private provider: IProductsProvider,
    private repo: IProductsRepository,
    private logger: ILogger
  ) {}

  async execute(context: JobContext): Promise<JobResult> {
    const { abortSignal } = context;
    this.logger.info(ProductsSyncJob.COMPONENT, 'Starting products sync');

    let errors = 0;
    let synced = 0;

    try {
      const rawProducts = await this.provider.getProducts(abortSignal);
      
      const normalized = rawProducts.map(raw => {
        try {
          return ProductMapper.normalize(raw);
        } catch (err) {
          errors++;
          return null;
        }
      }).filter(p => p !== null);

      if (abortSignal.aborted) {
        return { success: false, retryable: true, error: new Error('Aborted by scheduler') };
      }

      await this.repo.upsertMany(normalized);
      synced = normalized.length;
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
