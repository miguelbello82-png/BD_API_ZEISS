import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });

import { createPgPool, PgDatabaseExecutor, IDatabaseExecutor } from '../config/db';
import { ConsoleLogger, ILogger } from '../observability/Logger';
import { Scheduler, SyncExecutionResult } from '../engine/Scheduler';
import { buildCompositionRoot } from '../worker';
import { PgStoreResolutionService } from '../core/StoreResolutionService';
import { buildStoreCompositionRoot } from '../engine/StoreCompositionRoot';
import { StoreNotFoundError, StoreSuspendedError } from '../contracts/store';

export interface RunJobArgs {
  provider?: string;
  domain?: string;
  operation?: string;
  store?: string;
  legacy?: boolean;
  allowDisabled: boolean;
  force: boolean;
  help: boolean;
}

export const EXIT_CODES: Record<SyncExecutionResult, number> = {
  EXECUTED_SUCCESS: 0,
  EXECUTED_FAILED: 1,
  SKIPPED_LEASE: 2,
  SKIPPED_DISABLED: 3,
  CONFIGURATION_ERROR: 4,
  SKIPPED_NOT_DUE: 5,
};

export function parseRunJobArgs(args: string[]): RunJobArgs {
  const parsed: RunJobArgs = {
    allowDisabled: false,
    force: true, // Administrative execution runs regardless of interval by default
    help: false,
    legacy: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--provider') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed.provider = next.trim();
        i++;
      }
    } else if (arg.startsWith('--provider=')) {
      parsed.provider = arg.substring('--provider='.length).trim();
    } else if (arg === '--domain') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed.domain = next.trim();
        i++;
      }
    } else if (arg.startsWith('--domain=')) {
      parsed.domain = arg.substring('--domain='.length).trim();
    } else if (arg === '--operation') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed.operation = next.trim();
        i++;
      }
    } else if (arg.startsWith('--operation=')) {
      parsed.operation = arg.substring('--operation='.length).trim();
    } else if (arg === '--store') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed.store = next.trim();
        i++;
      }
    } else if (arg.startsWith('--store=')) {
      parsed.store = arg.substring('--store='.length).trim();
    } else if (arg === '--legacy') {
      parsed.legacy = true;
    } else if (arg === '--allow-disabled') {
      parsed.allowDisabled = true;
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--no-force' || arg === '--enforce-interval') {
      parsed.force = false;
    }
  }

  return parsed;
}

export function printHelp(): void {
  console.log(`
BD_API_ZEISS — Administrative Job Executor

Usage:
  npm run job:run -- --provider <provider> --domain <domain> --operation <operation> [options]
  node dist/cli/run-job.js --provider <provider> --domain <domain> --operation <operation> [options]

Required Options:
  --provider <name>     Target sync provider (e.g., 'zeiss')
  --domain <name>       Target functional domain (e.g., 'campaigns', 'orders', 'tracking')
  --operation <name>    Target operation (e.g., 'sync', 'discovery', 'redeemed')

Multi-Store Options:
  --store <code|uuid>   Target store code (e.g., 'continental') or store UUID
  --legacy              Force legacy execution mode (targets integration.sync_* tables)

Additional Options:
  --allow-disabled      Explicit authorization to execute a policy currently configured with enabled=false
  --force               Execute immediately regardless of temporal interval (default: true)
  --enforce-interval    Only execute if the policy is currently due according to interval_seconds
  --help, -h            Show this help message

Exit Codes:
  0: EXECUTED_SUCCESS
  1: EXECUTED_FAILED
  2: SKIPPED_LEASE
  3: SKIPPED_DISABLED
  4: CONFIGURATION_ERROR
  5: SKIPPED_NOT_DUE
`);
}

export interface RunJobDeps {
  scheduler?: Scheduler;
  logger: ILogger;
  db?: IDatabaseExecutor;
}

export async function runJob(
  args: RunJobArgs,
  deps: RunJobDeps
): Promise<{ result: SyncExecutionResult; exitCode: number }> {
  const { provider, domain, operation, store, legacy, allowDisabled, force } = args;

  if (!provider || !domain || !operation) {
    deps.logger.error('run-job', 'Missing required arguments: --provider, --domain, and --operation must be specified');
    return { result: 'CONFIGURATION_ERROR', exitCode: EXIT_CODES.CONFIGURATION_ERROR };
  }

  // Handle Multi-Store Execution
  if (store) {
    if (!deps.db) {
      deps.logger.error('run-job', 'Database executor required for multi-store job execution');
      return { result: 'CONFIGURATION_ERROR', exitCode: EXIT_CODES.CONFIGURATION_ERROR };
    }

    try {
      const storeService = new PgStoreResolutionService(deps.db);
      const storeContext = await storeService.resolveStore(store);

      deps.logger.info('run-job', `Starting job execution in store context [${storeContext.storeCode}] (${storeContext.storeId})`, {
        provider,
        domain,
        operation,
        store: storeContext.storeCode,
        storeId: storeContext.storeId,
        allowDisabled,
        force,
      });

      const root = buildStoreCompositionRoot(deps.db, storeContext, deps.logger);
      const result = await root.scheduler.executeOperation(provider, domain, operation, {
        allowDisabled,
        force,
      });

      const exitCode = EXIT_CODES[result] ?? 1;
      logExecutionOutcome(deps.logger, result, exitCode, { provider, domain, operation, store: storeContext.storeCode });
      return { result, exitCode };
    } catch (err) {
      if (err instanceof StoreNotFoundError) {
        deps.logger.error('run-job', `Store not found: ${store}`, { store });
        return { result: 'CONFIGURATION_ERROR', exitCode: EXIT_CODES.CONFIGURATION_ERROR };
      }
      if (err instanceof StoreSuspendedError) {
        deps.logger.warn('run-job', `Store is suspended: ${store}`, { store });
        return { result: 'SKIPPED_DISABLED', exitCode: EXIT_CODES.SKIPPED_DISABLED };
      }
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger.error('run-job', `Store resolution or execution error: ${msg}`, { error: msg, store });
      return { result: 'CONFIGURATION_ERROR', exitCode: EXIT_CODES.CONFIGURATION_ERROR };
    }
  }

  // Handle Unscoped / Legacy Execution
  const runtimeMode = (process.env.RUNTIME_MODE || 'legacy').toLowerCase();
  if (runtimeMode === 'multi_store' && !legacy) {
    deps.logger.error(
      'run-job',
      'In multi_store mode, --store <code|uuid> is required to prevent accidental unscoped execution. Pass --legacy to force legacy execution.'
    );
    return { result: 'CONFIGURATION_ERROR', exitCode: EXIT_CODES.CONFIGURATION_ERROR };
  }

  if (!deps.scheduler) {
    deps.logger.error('run-job', 'Scheduler instance required for legacy execution');
    return { result: 'CONFIGURATION_ERROR', exitCode: EXIT_CODES.CONFIGURATION_ERROR };
  }

  deps.logger.info('run-job', 'Starting legacy administrative job execution (no --store specified)', {
    provider,
    domain,
    operation,
    allowDisabled,
    force,
  });

  const result = await deps.scheduler.executeOperation(provider, domain, operation, {
    allowDisabled,
    force,
  });

  const exitCode = EXIT_CODES[result] ?? 1;
  logExecutionOutcome(deps.logger, result, exitCode, { provider, domain, operation });
  return { result, exitCode };
}

function logExecutionOutcome(
  logger: ILogger,
  result: SyncExecutionResult,
  exitCode: number,
  ctx: Record<string, unknown>
): void {
  if (result === 'EXECUTED_SUCCESS') {
    logger.info('run-job', `Job execution completed successfully [${result}]`, { ...ctx, exitCode });
  } else if (result === 'SKIPPED_LEASE' || result === 'SKIPPED_DISABLED' || result === 'SKIPPED_NOT_DUE') {
    logger.warn('run-job', `Job execution skipped [${result}]`, { ...ctx, exitCode });
  } else {
    logger.error('run-job', `Job execution failed or configuration error [${result}]`, { ...ctx, exitCode });
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const logger = new ConsoleLogger();
  const args = parseRunJobArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.provider || !args.domain || !args.operation) {
    printHelp();
    logger.error('run-job', 'Missing required arguments: --provider, --domain, and --operation must be specified');
    return EXIT_CODES.CONFIGURATION_ERROR;
  }

  let pool;
  try {
    pool = createPgPool();
    const db = new PgDatabaseExecutor(pool);
    const root = buildCompositionRoot(db, logger);
    const scheduler = root.scheduler;

    const { exitCode } = await runJob(args, { scheduler, logger, db });
    return exitCode;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('run-job', 'Fatal execution error', { error: msg });
    return EXIT_CODES.EXECUTED_FAILED;
  } finally {
    if (pool) {
      await pool.end();
      logger.info('run-job', 'Database pool closed');
    }
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error('Fatal unhandled error in run-job CLI:', err);
    process.exit(1);
  });
}
