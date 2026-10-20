import { IDatabaseExecutor } from '../config/db';
import { CompositionRoot, CompositionRootDeps } from './CompositionRoot';
import { StoreZeissContext } from '../contracts/store';
import { ConsoleLogger, ILogger } from '../observability/Logger';
import { RealClock, RealSleeper, IClock, ISleeper } from '../utils/Clock';
import { OrderStateMappingLoader } from '../config/OrderStateMappingLoader';
import { ZeissOrderClassifier, UnresolvedTrackingClassifier } from './Classifiers';

// Providers
import { OrdersProvider } from '../providers/orders';
import { VouchersProvider } from '../providers/vouchers';
import { FinancialProvider } from '../providers/financial';
import { ProductsProvider } from '../providers/products';

// Multi-Store Repositories
import { PgOrdersRepository } from '../repositories/postgres/OrdersRepository';
import { PgOrderDetailsRepository } from '../repositories/postgres/OrderDetailsRepository';
import { PgTrackingRepository } from '../repositories/postgres/TrackingRepository';
import { PgCampaignsRepository } from '../repositories/postgres/CampaignsRepository';
import { PgLeadsRepository } from '../repositories/postgres/LeadsRepository';
import { PgReceivablesRepository } from '../repositories/postgres/ReceivablesRepository';
import { PgProductsRepository } from '../repositories/postgres/ProductsRepository';
import { PgStoreSyncPolicyRepository } from '../repositories/postgres/StoreSyncPolicyRepository';
import { PgStoreSyncStateRepository } from '../repositories/postgres/StoreSyncStateRepository';
import { PgStoreSyncLeaseRepository } from '../repositories/postgres/StoreSyncLeaseRepository';
import { PgStoreProviderHealthRepository } from '../repositories/postgres/StoreProviderHealthRepository';
import { FencedDatabaseExecutor, LeaseFencingContext } from './FencedDatabaseExecutor';

export function buildStoreCompositionDeps(
  db: IDatabaseExecutor,
  storeContext: StoreZeissContext,
  logger: ILogger = new ConsoleLogger(),
  clock: IClock = new RealClock(),
  sleeper: ISleeper = new RealSleeper(),
  fencingContext?: LeaseFencingContext
): CompositionRootDeps {
  const storeId = storeContext.storeId;
  const effectiveDb = fencingContext ? new FencedDatabaseExecutor(db, fencingContext) : db;

  // Classifiers
  const mappingConfig = OrderStateMappingLoader.load();
  const orderClassifier = new ZeissOrderClassifier(mappingConfig);
  const trackingClassifier = new UnresolvedTrackingClassifier();

  // Setup Store-Scoped Providers
  const ordersProvider = new OrdersProvider(storeContext);
  const trackingProvider = new OrdersProvider(storeContext);
  const campaignsProvider = new VouchersProvider(storeContext);
  const leadsProvider = new VouchersProvider(storeContext);
  const receivablesProvider = new FinancialProvider(storeContext);
  const productsProvider = new ProductsProvider(storeContext);
  const detailProvider = new OrdersProvider(storeContext);

  // Setup Store-Scoped Data Repositories (protected by lease fencing when active)
  const ordersRepo = new PgOrdersRepository(effectiveDb, storeId);
  const detailsRepo = new PgOrderDetailsRepository(effectiveDb, storeId);
  const trackingRepo = new PgTrackingRepository(effectiveDb, storeId);
  const campaignsRepo = new PgCampaignsRepository(effectiveDb, storeId);
  const leadsRepo = new PgLeadsRepository(effectiveDb, storeId);
  const receivablesRepo = new PgReceivablesRepository(effectiveDb, storeId);
  const productsRepo = new PgProductsRepository(effectiveDb); // Global catalog

  // Setup Store-Scoped Sync Control Repositories
  const policyRepo = new PgStoreSyncPolicyRepository(db, storeId);
  const stateRepo = new PgStoreSyncStateRepository(db, storeId);
  const leaseRepo = new PgStoreSyncLeaseRepository(db, storeId);
  const healthRepo = new PgStoreProviderHealthRepository(effectiveDb, storeId);

  return {
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
    clock,
    sleeper,
  };
}

export function buildStoreCompositionRoot(
  db: IDatabaseExecutor,
  storeContext: StoreZeissContext,
  logger: ILogger = new ConsoleLogger(),
  clock: IClock = new RealClock(),
  sleeper: ISleeper = new RealSleeper(),
  fencingContext?: LeaseFencingContext
): CompositionRoot {
  const deps = buildStoreCompositionDeps(db, storeContext, logger, clock, sleeper, fencingContext);
  return new CompositionRoot(deps);
}
