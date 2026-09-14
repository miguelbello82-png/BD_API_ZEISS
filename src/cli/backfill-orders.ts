import { createPgPool, PgDatabaseExecutor } from '../config/db';
import { ConsoleLogger } from '../observability/Logger';
import { RealClock } from '../utils/Clock';
import { OrderStateMappingLoader } from '../config/OrderStateMappingLoader';
import { ZeissOrderClassifier } from '../engine/Classifiers';
import { OrdersProvider } from '../providers/orders';
import { PgOrdersRepository } from '../repositories/postgres/OrdersRepository';
import { PgOrderDetailsRepository } from '../repositories/postgres/OrderDetailsRepository';
import { PgSyncPolicyRepository } from '../repositories/postgres/SyncPolicyRepository';
import { PgSyncStateRepository } from '../repositories/postgres/SyncStateRepository';
import { PgSyncLeaseRepository } from '../repositories/postgres/SyncLeaseRepository';
import { BackfillOrchestrator } from '../engine/BackfillOrchestrator';

async function main() {
  const logger = new ConsoleLogger();
  const maxWindows = parseInt(process.env.MAX_BACKFILL_WINDOWS || '12', 10);
  const workerId = `manual-backfill-${process.pid}`;

  logger.info('backfill', `Starting backfill orders with maxWindows=${maxWindows}, workerId=${workerId}`);

  let pool;
  try {
    pool = createPgPool();
    const db = new PgDatabaseExecutor(pool);

    const mappingConfig = OrderStateMappingLoader.load();
    const classifier = new ZeissOrderClassifier(mappingConfig);
    const clock = new RealClock();

    const ordersProvider = new OrdersProvider();
    const detailProvider = new OrdersProvider();

    const ordersRepo = new PgOrdersRepository(db);
    const detailsRepo = new PgOrderDetailsRepository(db);
    const policyRepo = new PgSyncPolicyRepository(db);
    const stateRepo = new PgSyncStateRepository(db);
    const leaseRepo = new PgSyncLeaseRepository(db);

    const orchestrator = new BackfillOrchestrator({
      ordersProvider,
      detailProvider,
      ordersRepo,
      detailsRepo,
      policyRepo,
      stateRepo,
      leaseRepo,
      classifier,
      logger,
      clock,
      workerId
    });

    const result = await orchestrator.run(maxWindows);
    
    logger.info('backfill', 'Backfill Finished', result);

    if (!result.success) {
      process.exitCode = 1;
    }

  } catch (err) {
    logger.error('backfill', 'Fatal error', { error: String(err) });
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

main();
