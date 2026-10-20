import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });

import { createPgPool, PgDatabaseExecutor } from '../config/db';
import { PgStoreResolutionService } from '../core/StoreResolutionService';
import { StoreBootstrapOrchestrator } from '../engine/StoreBootstrapOrchestrator';
import { ConsoleLogger } from '../observability/Logger';
import { RealClock } from '../utils/Clock';

async function main() {
  const logger = new ConsoleLogger();
  const clock = new RealClock();
  const pool = createPgPool();
  const db = new PgDatabaseExecutor(pool);

  const storeResolutionService = new PgStoreResolutionService(db);
  const orchestrator = new StoreBootstrapOrchestrator(db, storeResolutionService, logger, clock);

  const storeId = process.argv[2] || '3cdde1d2-4461-475f-8faf-418bbb3790fd'; // Continental
  const lookbackDays = parseInt(process.env.BOOTSTRAP_LOOKBACK_DAYS || '90', 10);
  const sliceDays = parseInt(process.env.BOOTSTRAP_SLICE_DAYS || '7', 10);

  logger.info('BootstrapCLI', `Starting controlled bootstrap for store ${storeId} (lookbackDays=${lookbackDays}, sliceDays=${sliceDays})`);

  try {
    const result = await orchestrator.bootstrapStore(storeId, {
      lookbackDays,
      sliceDays,
      skipCatchUp: false,
    });

    console.log('\n=============================================');
    console.log('BOOTSTRAP EXECUTION RESULT:');
    console.log(JSON.stringify(result, null, 2));
    console.log('=============================================\n');

    if (!result.success) {
      process.exitCode = 1;
    }
  } catch (err) {
    logger.error('BootstrapCLI', 'Fatal error during bootstrap', { error: String(err) });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
