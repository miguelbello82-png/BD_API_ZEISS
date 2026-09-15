import { createPgPool, PgDatabaseExecutor } from '../config/db';
import { ConsoleLogger } from '../observability/Logger';
import { RealClock } from '../utils/Clock';
import { FinancialProvider } from '../providers/financial';
import { PgReceivablesRepository } from '../repositories/postgres/ReceivablesRepository';
import { PgSyncPolicyRepository } from '../repositories/postgres/SyncPolicyRepository';
import { PgSyncStateRepository } from '../repositories/postgres/SyncStateRepository';
import { PgSyncLeaseRepository } from '../repositories/postgres/SyncLeaseRepository';
import { ReceivablesBackfillOrchestrator } from '../engine/ReceivablesBackfillOrchestrator';
import { randomUUID } from 'crypto';

async function main() {
  const logger = new ConsoleLogger();
  const maxWindows = parseInt(process.env.MAX_BACKFILL_WINDOWS || '12', 10);
  const workerId = randomUUID();
  const workerLabel = `manual-backfill-receivables-${process.pid}`;

  logger.info('backfill', `Starting backfill receivables with maxWindows=${maxWindows}, workerId=${workerId}, label=${workerLabel}`);

  let pool;
  try {
    pool = createPgPool();
    const db = new PgDatabaseExecutor(pool);
    const clock = new RealClock();

    const provider = new FinancialProvider();
    const repo = new PgReceivablesRepository(db);
    const policyRepo = new PgSyncPolicyRepository(db);
    const stateRepo = new PgSyncStateRepository(db);
    const leaseRepo = new PgSyncLeaseRepository(db);

    const orchestrator = new ReceivablesBackfillOrchestrator({
      provider,
      repo,
      policyRepo,
      stateRepo,
      leaseRepo,
      logger,
      clock,
      workerId
    });

    const result = await orchestrator.run(maxWindows);
    
    logger.info('backfill', 'Receivables Backfill Finished', result);

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
