import { IDatabaseExecutor } from '../config/db';
import { IStoreResolutionService } from '../core/StoreResolutionService';
import { buildStoreCompositionRoot } from './StoreCompositionRoot';
import { ConsoleLogger, ILogger } from '../observability/Logger';
import { IClock, ISleeper, RealClock, RealSleeper } from '../utils/Clock';
import { SyncExecutionResult, ExecutePolicyOptions } from './Scheduler';

export interface MultiStoreTickResult {
  totalStores: number;
  successfulStores: number;
  failedStores: number;
}

export class MultiStoreOrchestrator {
  constructor(
    private db: IDatabaseExecutor,
    private storeService: IStoreResolutionService,
    private logger: ILogger = new ConsoleLogger(),
    private clock: IClock = new RealClock(),
    private sleeper: ISleeper = new RealSleeper()
  ) {}

  async tick(provider?: string): Promise<MultiStoreTickResult> {
    const stores = await this.storeService.listEligibleStores();
    this.logger.info('MultiStoreOrchestrator', `Found ${stores.length} eligible store(s) for synchronization`);

    let successfulStores = 0;
    let failedStores = 0;

    for (const store of stores) {
      this.logger.info('MultiStoreOrchestrator', `Starting scheduler tick for store: ${store.storeCode} (${store.storeId})`);
      try {
        const root = buildStoreCompositionRoot(this.db, store, this.logger, this.clock, this.sleeper);
        await root.scheduler.tick(provider);
        successfulStores++;
        this.logger.info('MultiStoreOrchestrator', `Completed scheduler tick for store: ${store.storeCode}`);
      } catch (err) {
        failedStores++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error('MultiStoreOrchestrator', `Failed scheduler tick for store ${store.storeCode}: ${msg}`, {
          storeId: store.storeId,
          storeCode: store.storeCode,
          error: msg
        });
        // Non-blocking: failure in one store does not halt processing of other stores
      }
    }

    return {
      totalStores: stores.length,
      successfulStores,
      failedStores
    };
  }

  async executeOperation(
    storeIdentifier: string,
    provider: string,
    domain: string,
    operation: string,
    options?: ExecutePolicyOptions
  ): Promise<SyncExecutionResult> {
    const store = await this.storeService.resolveStore(storeIdentifier);
    this.logger.info('MultiStoreOrchestrator', `Executing operation for store: ${store.storeCode} (${store.storeId})`, {
      provider,
      domain,
      operation
    });

    const root = buildStoreCompositionRoot(this.db, store, this.logger, this.clock, this.sleeper);
    return await root.scheduler.executeOperation(provider, domain, operation, options);
  }
}
