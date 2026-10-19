import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });

import { createPgPool, PgDatabaseExecutor, IDatabaseExecutor } from './config/db';
import { CompositionRoot, CompositionRootDeps } from './engine/CompositionRoot';
import { ConsoleLogger, ILogger } from './observability/Logger';
import { RealClock, RealSleeper, IClock, ISleeper } from './utils/Clock';
import { OrderStateMappingLoader } from './config/OrderStateMappingLoader';
import { ZeissOrderClassifier, UnresolvedTrackingClassifier } from './engine/Classifiers';

// Providers
import { OrdersProvider } from './providers/orders';
import { VouchersProvider } from './providers/vouchers';
import { FinancialProvider } from './providers/financial';
import { ProductsProvider } from './providers/products';

// Repositories
import { PgOrdersRepository } from './repositories/postgres/OrdersRepository';
import { PgOrderDetailsRepository } from './repositories/postgres/OrderDetailsRepository';
import { PgTrackingRepository } from './repositories/postgres/TrackingRepository';
import { PgCampaignsRepository } from './repositories/postgres/CampaignsRepository';
import { PgLeadsRepository } from './repositories/postgres/LeadsRepository';
import { PgReceivablesRepository } from './repositories/postgres/ReceivablesRepository';
import { PgProductsRepository } from './repositories/postgres/ProductsRepository';
import { PgSyncPolicyRepository } from './repositories/postgres/SyncPolicyRepository';
import { PgSyncStateRepository } from './repositories/postgres/SyncStateRepository';
import { PgSyncLeaseRepository } from './repositories/postgres/SyncLeaseRepository';
import { PgProviderHealthRepository } from './repositories/postgres/ProviderHealthRepository';

// Multi-Store Support
import { PgStoreResolutionService } from './core/StoreResolutionService';
import { CentralMultiStoreScheduler, CentralSchedulerTickResult } from './engine/CentralMultiStoreScheduler';

export function buildCompositionRoot(db: IDatabaseExecutor, logger: ILogger = new ConsoleLogger()): CompositionRoot {
  // Classifiers
  const mappingConfig = OrderStateMappingLoader.load();
  const orderClassifier = new ZeissOrderClassifier(mappingConfig);
  const trackingClassifier = new UnresolvedTrackingClassifier();

  // Setup Providers (Legacy mode uses ambient zeissConfig)
  const ordersProvider = new OrdersProvider();
  const trackingProvider = new OrdersProvider();
  const campaignsProvider = new VouchersProvider();
  const leadsProvider = new VouchersProvider();
  const receivablesProvider = new FinancialProvider();
  const productsProvider = new ProductsProvider();
  const detailProvider = new OrdersProvider();

  // Setup Repositories (Legacy mode without store_id scoping)
  const ordersRepo = new PgOrdersRepository(db);
  const detailsRepo = new PgOrderDetailsRepository(db);
  const trackingRepo = new PgTrackingRepository(db);
  const campaignsRepo = new PgCampaignsRepository(db);
  const leadsRepo = new PgLeadsRepository(db);
  const receivablesRepo = new PgReceivablesRepository(db);
  const productsRepo = new PgProductsRepository(db);
  
  const policyRepo = new PgSyncPolicyRepository(db);
  const stateRepo = new PgSyncStateRepository(db);
  const leaseRepo = new PgSyncLeaseRepository(db);
  const healthRepo = new PgProviderHealthRepository(db);

  const deps: CompositionRootDeps = {
    policyRepo,
    stateRepo,
    leaseRepo,
    healthRepo,
    ordersRepo,
    detailsRepo,
    trackingRepo,
    campaignsRepo,
    leadsRepo,
    receivablesRepo,
    productsRepo,

    ordersProvider,
    detailProvider,
    trackingProvider,
    campaignsProvider,
    leadsProvider,
    receivablesProvider,
    productsProvider,

    orderClassifier,
    trackingClassifier,
    logger,
    clock: new RealClock(),
    sleeper: new RealSleeper(),
  };

  return new CompositionRoot(deps);
}

export interface WorkerExecutionResult {
  mode: 'legacy' | 'multi_store';
  legacySuccess?: boolean;
  multiStoreResult?: CentralSchedulerTickResult;
}

/**
 * Executes a single tick of the worker according to RUNTIME_MODE.
 * Legacy mode (default) uses CompositionRoot & single-store scheduler.
 * Multi-store mode uses CentralMultiStoreScheduler with dynamic discovery & central policy map.
 */
export async function executeWorkerTick(
  db: IDatabaseExecutor,
  runtimeMode: string = process.env.RUNTIME_MODE || 'legacy',
  logger: ILogger = new ConsoleLogger(),
  clock: IClock = new RealClock(),
  sleeper: ISleeper = new RealSleeper()
): Promise<WorkerExecutionResult> {
  const normalizedMode = runtimeMode.toLowerCase();

  if (normalizedMode === 'multi_store') {
    logger.info('worker', 'Executing in MULTI_STORE mode with central policy scheduler and dynamic store discovery');
    const storeResolutionService = new PgStoreResolutionService(db);
    const globalPolicyRepo = new PgSyncPolicyRepository(db);
    const centralScheduler = new CentralMultiStoreScheduler({
      globalPolicyRepo,
      storeResolutionService,
      db,
      logger,
      clock,
      sleeper
    });

    const multiStoreResult = await centralScheduler.tick();
    logger.info('worker', 'Central multi-store scheduler tick completed', {
      totalPolicies: multiStoreResult.totalPolicies,
      totalActiveStores: multiStoreResult.totalActiveStores,
      executedCount: multiStoreResult.executions.length
    });

    return {
      mode: 'multi_store',
      multiStoreResult
    };
  } else {
    // Legacy mode (default during transition)
    logger.info('worker', 'Executing in LEGACY single-store mode');
    const root = buildCompositionRoot(db, logger);
    const scheduler = root.scheduler;
    await scheduler.tick();
    logger.info('worker', 'Legacy worker tick completed successfully');

    return {
      mode: 'legacy',
      legacySuccess: true
    };
  }
}

async function main() {
  const logger = new ConsoleLogger();
  const runtimeMode = (process.env.RUNTIME_MODE || 'legacy').toLowerCase();
  logger.info('worker', `Starting worker execution [RUNTIME_MODE=${runtimeMode}]`);

  let pool;
  try {
    pool = createPgPool();
    const db = new PgDatabaseExecutor(pool);
    await executeWorkerTick(db, runtimeMode, logger);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('worker', 'Execution failed', { error: msg });
    process.exitCode = 1;
  } finally {
    if (pool) {
      await pool.end();
      logger.info('worker', 'Database connection pool closed');
    }
  }
}

// Execute if this file is run directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal unhandled error in worker:', err);
    process.exit(1);
  });
}
