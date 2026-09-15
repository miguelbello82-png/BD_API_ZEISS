import { createPgPool, PgDatabaseExecutor } from '../config/db';
import { ConsoleLogger } from '../observability/Logger';
import { OrdersProvider } from '../providers/orders';
import { PgTrackingRepository } from '../repositories/postgres/TrackingRepository';
import { PgSyncPolicyRepository } from '../repositories/postgres/SyncPolicyRepository';
import { PgSyncStateRepository } from '../repositories/postgres/SyncStateRepository';
import { PgSyncLeaseRepository } from '../repositories/postgres/SyncLeaseRepository';
import { TrackingBackfillOrchestrator } from '../engine/TrackingBackfillOrchestrator';
import { randomUUID } from 'crypto';
import { ZeissOrderClassifier, UnresolvedTrackingClassifier } from '../engine/Classifiers';
import { OrderStateMappingLoader } from '../config/OrderStateMappingLoader';

async function main() {
  const logger = new ConsoleLogger();
  const maxBatches = parseInt(process.env.MAX_BACKFILL_BATCHES || '1000', 10);
  const workerId = randomUUID();
  const workerLabel = `manual-backfill-tracking-${process.pid}`;

  logger.info('backfill-tracking', `Starting tracking backfill with maxBatches=${maxBatches}, workerId=${workerId}, label=${workerLabel}`);

  let pool;
  try {
    pool = createPgPool();
    const db = new PgDatabaseExecutor(pool);

    const mappingConfig = OrderStateMappingLoader.load();
    const orderClassifier = new ZeissOrderClassifier(mappingConfig);
    const trackingClassifier = new UnresolvedTrackingClassifier();

    const trackingProvider = new OrdersProvider();
    const trackingRepo = new PgTrackingRepository(db);
    const policyRepo = new PgSyncPolicyRepository(db);
    const stateRepo = new PgSyncStateRepository(db);
    const leaseRepo = new PgSyncLeaseRepository(db);

    const orchestrator = new TrackingBackfillOrchestrator({
      trackingProvider,
      trackingRepo,
      policyRepo,
      stateRepo,
      leaseRepo,
      orderClassifier,
      trackingClassifier,
      logger,
      workerId
    });

    const result = await orchestrator.run(maxBatches);
    
    logger.info('backfill-tracking', 'Backfill Finished', result);

    if (!result.success) {
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error('backfill-tracking', 'Fatal backfill error', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    if (pool) {
      await pool.end();
    }
  }
}

main();
