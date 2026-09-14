import { JobRegistry } from './JobRegistry';
import { OrdersSync } from './OrdersSync';
import { TrackingSync } from './TrackingSync';
import { CampaignsSyncJob } from './jobs/CampaignsSyncJob';
import { LeadsSyncJob } from './jobs/LeadsSyncJob';
import { LeadsRedeemedSyncJob } from './jobs/LeadsRedeemedSyncJob';
import { ReceivablesSyncJob } from './jobs/ReceivablesSyncJob';
import { ProductsSyncJob } from './jobs/ProductsSyncJob';

// Interfaces for dependencies that would be provided by a DI container or manual assembly
import {
  ISyncPolicyRepository,
  ISyncStateRepository,
  ISyncLeaseRepository,
  IProviderHealthRepository,
  IOrdersRepository,
  IOrderDetailsRepository,
  ITrackingRepository,
  ICampaignsRepository,
  ILeadsRepository,
  IReceivablesRepository,
  IProductsRepository
} from '../contracts/repositories';

import {
  IOrdersListProvider,
  IOrderDetailProvider,
  ITrackingProvider,
  ICampaignsProvider,
  ILeadsProvider,
  IReceivablesProvider,
  IProductsProvider
} from '../contracts/providers';

import { IOrderClassifier, ITrackingClassifier } from './Classifiers';
import { ILogger } from '../observability/Logger';
import { Scheduler } from './Scheduler';
import { IClock, ISleeper } from '../utils/Clock';

export interface CompositionRootDeps {
  // Repositories
  policyRepo: ISyncPolicyRepository;
  stateRepo: ISyncStateRepository;
  leaseRepo: ISyncLeaseRepository;
  healthRepo: IProviderHealthRepository;
  ordersRepo: IOrdersRepository;
  detailsRepo: IOrderDetailsRepository;
  trackingRepo: ITrackingRepository;
  campaignsRepo: ICampaignsRepository;
  leadsRepo: ILeadsRepository;
  receivablesRepo: IReceivablesRepository;
  productsRepo: IProductsRepository;

  // Providers
  ordersProvider: IOrdersListProvider;
  detailProvider: IOrderDetailProvider;
  trackingProvider: ITrackingProvider;
  campaignsProvider: ICampaignsProvider;
  leadsProvider: ILeadsProvider;
  receivablesProvider: IReceivablesProvider;
  productsProvider: IProductsProvider;

  // Domain/Core
  orderClassifier: IOrderClassifier;
  trackingClassifier: ITrackingClassifier;
  logger: ILogger;
  clock: IClock;
  sleeper: ISleeper;
}

export class CompositionRoot {
  public readonly registry: JobRegistry;
  public readonly scheduler: Scheduler;

  constructor(deps: CompositionRootDeps) {
    this.registry = new JobRegistry();
    
    // Instantiate Jobs
    const ordersDiscovery = new OrdersSync({
      ordersProvider: deps.ordersProvider,
      detailProvider: deps.detailProvider,
      ordersRepo: deps.ordersRepo,
      detailsRepo: deps.detailsRepo,
      classifier: deps.orderClassifier,
      logger: deps.logger,
      clock: deps.clock
    });

    const trackingSync = new TrackingSync({
      trackingProvider: deps.trackingProvider,
      trackingRepo: deps.trackingRepo,
      orderClassifier: deps.orderClassifier,
      trackingClassifier: deps.trackingClassifier,
      logger: deps.logger
    });

    const productsSync = new ProductsSyncJob(deps.productsProvider, deps.productsRepo, deps.logger);
    const campaignsSync = new CampaignsSyncJob(deps.campaignsProvider, deps.campaignsRepo, deps.logger);
    const leadsSync = new LeadsSyncJob(deps.leadsProvider, deps.stateRepo, deps.leadsRepo, deps.logger);
    const leadsRedeemedSync = new LeadsRedeemedSyncJob(deps.leadsProvider, deps.stateRepo, deps.leadsRepo, deps.logger);
    const receivablesSync = new ReceivablesSyncJob(deps.receivablesProvider, deps.receivablesRepo, deps.logger, deps.clock);

    // Register all 7 background operations
    this.registry.register('zeiss', 'orders', 'discovery', ordersDiscovery);
    this.registry.register('zeiss', 'tracking', 'sync', trackingSync);
    this.registry.register('zeiss', 'products', 'sync', productsSync);
    this.registry.register('zeiss', 'campaigns', 'sync', campaignsSync);
    this.registry.register('zeiss', 'leads', 'sync', leadsSync);
    this.registry.register('zeiss', 'leads', 'redeemed', leadsRedeemedSync);
    this.registry.register('zeiss', 'receivables', 'sync', receivablesSync);

    // Instantiate Scheduler
    this.scheduler = new Scheduler({
      policyRepo: deps.policyRepo,
      stateRepo: deps.stateRepo,
      leaseRepo: deps.leaseRepo,
      healthRepo: deps.healthRepo,
      jobRegistry: this.registry,
      logger: deps.logger,
      clock: deps.clock,
      sleeper: deps.sleeper
    });
  }
}
