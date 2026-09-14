import { createPgPool, PgDatabaseExecutor } from './config/db';
import { CompositionRoot, CompositionRootDeps } from './engine/CompositionRoot';
import { ConsoleLogger } from './observability/Logger';
import { RealClock, RealSleeper } from './utils/Clock';
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

async function main() {
  const logger = new ConsoleLogger();
  logger.info('worker', 'Starting one-shot execution');

  let pool;
  try {
    pool = createPgPool();
    const db = new PgDatabaseExecutor(pool);

    // Classifiers
    const mappingConfig = OrderStateMappingLoader.load();
    const orderClassifier = new ZeissOrderClassifier(mappingConfig);
    const trackingClassifier = new UnresolvedTrackingClassifier();

    // Setup Providers
    const ordersProvider = new OrdersProvider();
    const trackingProvider = new OrdersProvider();
    const campaignsProvider = new VouchersProvider();
    const leadsProvider = new VouchersProvider();
    const receivablesProvider = new FinancialProvider();
    const productsProvider = new ProductsProvider();
    const detailProvider = new OrdersProvider();

    // Setup Repositories
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

    const root = new CompositionRoot(deps);
    const scheduler = root.scheduler;

    // Run one-shot tick for all enabled policies
    logger.info('worker', 'Running scheduler tick for enabled policies...');
    await scheduler.tick();
    
    logger.info('worker', 'One-shot execution completed successfully');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('worker', 'One-shot execution failed', { error: msg });
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
