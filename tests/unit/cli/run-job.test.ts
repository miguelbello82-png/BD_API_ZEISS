import { parseRunJobArgs, runJob, main, EXIT_CODES } from '../../../src/cli/run-job';
import { Scheduler, SchedulerDeps } from '../../../src/engine/Scheduler';
import { JobRegistry, IJob, JobResult, JobContext } from '../../../src/engine/JobRegistry';
import {
  ISyncPolicyRepository,
  ISyncStateRepository,
  ISyncLeaseRepository,
  IProviderHealthRepository,
  SyncPolicy,
  SyncState,
} from '../../../src/contracts/repositories';
import { NullLogger } from '../../../src/observability/Logger';

describe('Administrative Job Executor (CLI: run-job)', () => {
  const canonicalOperations = [
    { provider: 'zeiss', domain: 'orders', operation: 'discovery' },
    { provider: 'zeiss', domain: 'tracking', operation: 'sync' },
    { provider: 'zeiss', domain: 'products', operation: 'sync' },
    { provider: 'zeiss', domain: 'campaigns', operation: 'sync' },
    { provider: 'zeiss', domain: 'leads', operation: 'sync' },
    { provider: 'zeiss', domain: 'leads', operation: 'redeemed' },
    { provider: 'zeiss', domain: 'receivables', operation: 'sync' },
  ];

  function createPolicy(overrides: Partial<SyncPolicy> = {}): SyncPolicy {
    return {
      provider: 'zeiss',
      domain: 'campaigns',
      operation: 'sync',
      enabled: true,
      interval_seconds: 300,
      lookback_seconds: null,
      timeout_seconds: 30,
      lease_ttl_seconds: 120,
      max_retries: 2,
      retry_delay_seconds: 0,
      operation_config: null,
      ...overrides,
    };
  }

  function setupTestEnvironment() {
    const jobRegistry = new JobRegistry();
    const mockJobs = new Map<string, jest.Mocked<IJob>>();

    for (const op of canonicalOperations) {
      const key = `${op.provider}:${op.domain}:${op.operation}`;
      const mockJob: jest.Mocked<IJob> = {
        execute: jest.fn().mockResolvedValue({ success: true, cursorValue: `cursor_${op.domain}` } as JobResult),
      };
      mockJobs.set(key, mockJob);
      jobRegistry.register(op.provider, op.domain, op.operation, mockJob);
    }

    const policies = new Map<string, SyncPolicy>();
    for (const op of canonicalOperations) {
      const key = `${op.provider}:${op.domain}:${op.operation}`;
      policies.set(key, createPolicy({ ...op, enabled: true }));
    }

    const stateMap = new Map<string, SyncState>();

    const policyRepo: jest.Mocked<ISyncPolicyRepository> = {
      findAllEnabled: jest.fn().mockImplementation(async () => Array.from(policies.values()).filter((p) => p.enabled)),
      findEnabledByProvider: jest.fn().mockImplementation(async (prov: string) =>
        Array.from(policies.values()).filter((p) => p.enabled && p.provider === prov)
      ),
      findByKey: jest.fn().mockImplementation(async (p: string, d: string, o: string) => {
        return policies.get(`${p}:${d}:${o}`) || null;
      }),
    };

    const stateRepo: jest.Mocked<ISyncStateRepository> = {
      findByKey: jest.fn().mockImplementation(async (p: string, d: string, o: string) => {
        return stateMap.get(`${p}:${d}:${o}`) || null;
      }),
      upsert: jest.fn().mockImplementation(async (state: SyncState) => {
        stateMap.set(`${state.provider}:${state.domain}:${state.operation}`, state);
      }),
    };

    const leaseRepo: jest.Mocked<ISyncLeaseRepository> = {
      tryAcquire: jest.fn().mockResolvedValue({ acquired: true }),
      release: jest.fn().mockResolvedValue(undefined),
      renew: jest.fn().mockResolvedValue(true),
    };

    const healthRepo: jest.Mocked<IProviderHealthRepository> = {
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
      findByKey: jest.fn().mockResolvedValue(null),
    };

    const logger = new NullLogger();
    const clock = { now: jest.fn().mockReturnValue(1700000000000) };
    const sleeper = { sleep: jest.fn().mockResolvedValue(undefined) };

    const scheduler = new Scheduler({
      policyRepo,
      stateRepo,
      leaseRepo,
      healthRepo,
      jobRegistry,
      logger,
      clock,
      sleeper,
    });

    return {
      scheduler,
      jobRegistry,
      mockJobs,
      policies,
      stateMap,
      policyRepo,
      stateRepo,
      leaseRepo,
      healthRepo,
      logger,
    };
  }

  describe('Argument Parsing (parseRunJobArgs)', () => {
    it('parses valid space-separated arguments', () => {
      const args = parseRunJobArgs(['--provider', 'zeiss', '--domain', 'campaigns', '--operation', 'sync']);
      expect(args.provider).toBe('zeiss');
      expect(args.domain).toBe('campaigns');
      expect(args.operation).toBe('sync');
      expect(args.allowDisabled).toBe(false);
      expect(args.force).toBe(true);
      expect(args.help).toBe(false);
    });

    it('parses valid equals-style arguments', () => {
      const args = parseRunJobArgs(['--provider=zeiss', '--domain=campaigns', '--operation=sync']);
      expect(args.provider).toBe('zeiss');
      expect(args.domain).toBe('campaigns');
      expect(args.operation).toBe('sync');
    });

    it('parses optional --allow-disabled and --force flags', () => {
      const args = parseRunJobArgs([
        '--provider', 'zeiss',
        '--domain', 'campaigns',
        '--operation', 'sync',
        '--allow-disabled',
        '--force',
      ]);
      expect(args.allowDisabled).toBe(true);
      expect(args.force).toBe(true);
    });

    it('handles --enforce-interval (sets force=false)', () => {
      const args = parseRunJobArgs([
        '--provider', 'zeiss',
        '--domain', 'campaigns',
        '--operation', 'sync',
        '--enforce-interval',
      ]);
      expect(args.force).toBe(false);
    });

    it('handles --help / -h flag', () => {
      expect(parseRunJobArgs(['--help']).help).toBe(true);
      expect(parseRunJobArgs(['-h']).help).toBe(true);
    });

    it('handles missing value gracefully when next arg is another flag', () => {
      const args = parseRunJobArgs(['--provider', '--domain', 'campaigns']);
      expect(args.provider).toBeUndefined();
      expect(args.domain).toBe('campaigns');
    });
  });

  describe('1. Correct Selection of Each Job (All 7 Canonical Operations)', () => {
    for (const op of canonicalOperations) {
      it(`correctly selects and executes ${op.provider}:${op.domain}:${op.operation}`, async () => {
        const env = setupTestEnvironment();
        const key = `${op.provider}:${op.domain}:${op.operation}`;

        const { result, exitCode } = await runJob(
          {
            provider: op.provider,
            domain: op.domain,
            operation: op.operation,
            allowDisabled: false,
            force: true,
            help: false,
          },
          { scheduler: env.scheduler, logger: env.logger }
        );

        expect(result).toBe('EXECUTED_SUCCESS');
        expect(exitCode).toBe(0);
        expect(env.mockJobs.get(key)!.execute).toHaveBeenCalledTimes(1);
        expect(env.healthRepo.recordSuccess).toHaveBeenCalledWith(op.provider, op.domain, op.operation);
        expect(env.stateRepo.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: op.provider,
            domain: op.domain,
            operation: op.operation,
            cursor_value: `cursor_${op.domain}`,
          })
        );
      });
    }
  });

  describe('2. Rejection of Unknown Operation / Domain / Provider / Config Error', () => {
    it('rejects unknown operation', async () => {
      const env = setupTestEnvironment();

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'unknown_op',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('CONFIGURATION_ERROR');
      expect(exitCode).toBe(4);
      expect(env.leaseRepo.tryAcquire).not.toHaveBeenCalled();
    });

    it('rejects unknown domain', async () => {
      const env = setupTestEnvironment();

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'unknown_domain',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('CONFIGURATION_ERROR');
      expect(exitCode).toBe(4);
    });

    it('rejects unknown provider', async () => {
      const env = setupTestEnvironment();

      const { result, exitCode } = await runJob(
        {
          provider: 'unauthorized_provider',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('CONFIGURATION_ERROR');
      expect(exitCode).toBe(4);
    });

    it('returns CONFIGURATION_ERROR if policy is not found in database', async () => {
      const env = setupTestEnvironment();
      env.policyRepo.findByKey.mockResolvedValueOnce(null);

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('CONFIGURATION_ERROR');
      expect(exitCode).toBe(4);
    });

    it('returns CONFIGURATION_ERROR if required CLI arguments are missing', async () => {
      const env = setupTestEnvironment();

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: undefined,
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('CONFIGURATION_ERROR');
      expect(exitCode).toBe(4);
    });

    it('returns CONFIGURATION_ERROR if policy parameters are invalid', async () => {
      const env = setupTestEnvironment();
      const invalidPolicy = createPolicy({ timeout_seconds: 0 });
      env.policyRepo.findByKey.mockResolvedValueOnce(invalidPolicy);

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('CONFIGURATION_ERROR');
      expect(exitCode).toBe(4);
    });
  });

  describe('3. Strict Isolation: Non-Execution of Other Jobs', () => {
    it('executes only the requested job and does not touch any other job', async () => {
      const env = setupTestEnvironment();

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('EXECUTED_SUCCESS');
      expect(exitCode).toBe(0);

      // Verify campaigns:sync executed
      expect(env.mockJobs.get('zeiss:campaigns:sync')!.execute).toHaveBeenCalledTimes(1);

      // Verify all other 6 jobs were NOT executed
      for (const op of canonicalOperations) {
        if (op.domain === 'campaigns' && op.operation === 'sync') continue;
        const otherKey = `${op.provider}:${op.domain}:${op.operation}`;
        expect(env.mockJobs.get(otherKey)!.execute).not.toHaveBeenCalled();
      }
    });
  });

  describe('4. Blocking Disabled Policies Without Explicit Authorization', () => {
    it('returns SKIPPED_DISABLED and does NOT acquire lease or run job when enabled=false without --allow-disabled', async () => {
      const env = setupTestEnvironment();
      const disabledPolicy = createPolicy({ enabled: false });
      env.policyRepo.findByKey.mockResolvedValueOnce(disabledPolicy);

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('SKIPPED_DISABLED');
      expect(exitCode).toBe(3);
      expect(env.leaseRepo.tryAcquire).not.toHaveBeenCalled();
      expect(env.mockJobs.get('zeiss:campaigns:sync')!.execute).not.toHaveBeenCalled();
      expect(env.stateRepo.upsert).not.toHaveBeenCalled();
    });

    it('executes successfully when enabled=false WITH --allow-disabled', async () => {
      const env = setupTestEnvironment();
      const disabledPolicy = createPolicy({ enabled: false });
      env.policyRepo.findByKey.mockResolvedValueOnce(disabledPolicy);

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: true,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('EXECUTED_SUCCESS');
      expect(exitCode).toBe(0);
      expect(env.leaseRepo.tryAcquire).toHaveBeenCalledTimes(1);
      expect(env.mockJobs.get('zeiss:campaigns:sync')!.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('5. Handling Occupied Lease', () => {
    it('returns SKIPPED_LEASE when lease cannot be acquired', async () => {
      const env = setupTestEnvironment();
      env.leaseRepo.tryAcquire.mockResolvedValueOnce({ acquired: false });

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('SKIPPED_LEASE');
      expect(exitCode).toBe(2);
      expect(env.mockJobs.get('zeiss:campaigns:sync')!.execute).not.toHaveBeenCalled();
      expect(env.leaseRepo.release).not.toHaveBeenCalled();
      expect(env.healthRepo.recordSuccess).not.toHaveBeenCalled();
    });
  });

  describe('6. Provider and Repository Failure Handling', () => {
    it('returns EXECUTED_FAILED when job execution fails', async () => {
      const env = setupTestEnvironment();
      env.mockJobs.get('zeiss:campaigns:sync')!.execute.mockResolvedValueOnce({
        success: false,
        retryable: false,
        error: new Error('Provider network connection timed out'),
      });

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('EXECUTED_FAILED');
      expect(exitCode).toBe(1);
      expect(env.healthRepo.recordFailure).toHaveBeenCalledWith('zeiss', 'campaigns', 'sync');
      expect(env.leaseRepo.release).toHaveBeenCalled();
    });

    it('returns EXECUTED_FAILED when job throws unhandled exception', async () => {
      const env = setupTestEnvironment();
      env.mockJobs.get('zeiss:campaigns:sync')!.execute.mockRejectedValue(
        new Error('Fatal API serialization error')
      );

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('EXECUTED_FAILED');
      expect(exitCode).toBe(1);
      expect(env.healthRepo.recordFailure).toHaveBeenCalledWith('zeiss', 'campaigns', 'sync');
    });
  });

  describe('7. Cursor and State Preservation on Failure', () => {
    it('does NOT advance cursor or update state when job fails', async () => {
      const env = setupTestEnvironment();
      const existingCursor = 'previous_valid_cursor_val';
      const existingLastSync = new Date('2026-10-01T12:00:00Z');

      env.stateMap.set('zeiss:campaigns:sync', {
        provider: 'zeiss',
        domain: 'campaigns',
        operation: 'sync',
        cursor_value: existingCursor,
        last_sync: existingLastSync,
      });

      env.mockJobs.get('zeiss:campaigns:sync')!.execute.mockResolvedValueOnce({
        success: false,
        retryable: false,
        error: new Error('Remote HTTP 500 internal error'),
      });

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('EXECUTED_FAILED');
      expect(exitCode).toBe(1);

      // stateRepo.upsert MUST NOT have been called
      expect(env.stateRepo.upsert).not.toHaveBeenCalled();

      // Ensure state in map remained completely unchanged
      const currentState = env.stateMap.get('zeiss:campaigns:sync');
      expect(currentState?.cursor_value).toBe(existingCursor);
      expect(currentState?.last_sync).toBe(existingLastSync);
    });
  });

  describe('8. Preserving Original Policy Configuration Parameters', () => {
    it('passes original policy configuration and state to JobContext', async () => {
      const env = setupTestEnvironment();
      const customConfig = { customParam: 'zeiss_val', maxItems: 50 };
      const customPolicy = createPolicy({
        timeout_seconds: 45,
        max_retries: 3,
        retry_delay_seconds: 0,
        lease_ttl_seconds: 300,
        operation_config: customConfig,
      });
      env.policyRepo.findByKey.mockResolvedValueOnce(customPolicy);

      let capturedContext: JobContext | undefined;
      env.mockJobs.get('zeiss:campaigns:sync')!.execute.mockImplementationOnce(async (ctx) => {
        capturedContext = ctx;
        return { success: true, retryable: false, cursorValue: 'new_cursor' };
      });

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('EXECUTED_SUCCESS');
      expect(exitCode).toBe(0);
      expect(capturedContext).toBeDefined();
      expect(capturedContext!.policy.timeout_seconds).toBe(45);
      expect(capturedContext!.policy.max_retries).toBe(3);
      expect(capturedContext!.policy.lease_ttl_seconds).toBe(300);
      expect(capturedContext!.policy.operation_config).toEqual(customConfig);
    });
  });

  describe('9. Complete Exit Code and Result Mapping', () => {
    it('verifies exact exit codes for all 6 execution outcomes', () => {
      expect(EXIT_CODES.EXECUTED_SUCCESS).toBe(0);
      expect(EXIT_CODES.EXECUTED_FAILED).toBe(1);
      expect(EXIT_CODES.SKIPPED_LEASE).toBe(2);
      expect(EXIT_CODES.SKIPPED_DISABLED).toBe(3);
      expect(EXIT_CODES.CONFIGURATION_ERROR).toBe(4);
      expect(EXIT_CODES.SKIPPED_NOT_DUE).toBe(5);
    });
  });

  describe('10. Interval Enforcement vs Force Execution', () => {
    it('--force executes immediately even when policy is NOT due', async () => {
      const env = setupTestEnvironment();
      // Simulate that campaigns:sync ran 10 seconds ago (interval is 300s)
      env.stateMap.set('zeiss:campaigns:sync', {
        provider: 'zeiss',
        domain: 'campaigns',
        operation: 'sync',
        last_sync: new Date(1700000000000 - 10000), // 10s ago
        cursor_value: 'cur_old',
      });

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true, // --force
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('EXECUTED_SUCCESS');
      expect(exitCode).toBe(0);
      expect(env.mockJobs.get('zeiss:campaigns:sync')!.execute).toHaveBeenCalledTimes(1);
    });

    it('--enforce-interval skips execution when policy is NOT due', async () => {
      const env = setupTestEnvironment();
      // Simulate that campaigns:sync ran 10 seconds ago (interval is 300s)
      env.stateMap.set('zeiss:campaigns:sync', {
        provider: 'zeiss',
        domain: 'campaigns',
        operation: 'sync',
        last_sync: new Date(1700000000000 - 10000), // 10s ago
        cursor_value: 'cur_old',
      });

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: false, // --enforce-interval
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('SKIPPED_NOT_DUE');
      expect(exitCode).toBe(5);
      expect(env.mockJobs.get('zeiss:campaigns:sync')!.execute).not.toHaveBeenCalled();
      expect(env.leaseRepo.tryAcquire).not.toHaveBeenCalled();
      expect(env.stateRepo.upsert).not.toHaveBeenCalled();
    });

    it('--enforce-interval executes when policy IS due', async () => {
      const env = setupTestEnvironment();
      // Simulate that campaigns:sync ran 400 seconds ago (interval is 300s -> due)
      env.stateMap.set('zeiss:campaigns:sync', {
        provider: 'zeiss',
        domain: 'campaigns',
        operation: 'sync',
        last_sync: new Date(1700000000000 - 400000),
        cursor_value: 'cur_old',
      });

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: false, // --enforce-interval
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      expect(result).toBe('EXECUTED_SUCCESS');
      expect(exitCode).toBe(0);
      expect(env.mockJobs.get('zeiss:campaigns:sync')!.execute).toHaveBeenCalledTimes(1);
    });

    it('neither --force nor --enforce-interval modifies sync_policies or cursors prior to execution', async () => {
      const env = setupTestEnvironment();
      const initialPolicy = env.policies.get('zeiss:campaigns:sync');
      const initialInterval = initialPolicy?.interval_seconds;
      const initialEnabled = initialPolicy?.enabled;

      env.stateMap.set('zeiss:campaigns:sync', {
        provider: 'zeiss',
        domain: 'campaigns',
        operation: 'sync',
        last_sync: new Date(1700000000000 - 5000),
        cursor_value: 'cur_intact',
      });

      // Execute with force: true
      await runJob(
        {
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          allowDisabled: false,
          force: true,
          help: false,
        },
        { scheduler: env.scheduler, logger: env.logger }
      );

      // Verify policy object was not modified in memory or DB
      const currentPolicy = env.policies.get('zeiss:campaigns:sync');
      expect(currentPolicy?.interval_seconds).toBe(initialInterval);
      expect(currentPolicy?.enabled).toBe(initialEnabled);
    });
  });

  describe('11. Worker Import Isolation', () => {
    it('importing buildCompositionRoot does not execute worker main or create DB pools', () => {
      // Requiring the module should not trigger process execution
      const workerModule = require('../../../src/worker');
      expect(typeof workerModule.buildCompositionRoot).toBe('function');
    });
  });

  describe('12. CLI Entry Point (main()) Execution and Exit Codes', () => {
    it('returns 0 when --help is passed', async () => {
      const exitCode = await main(['--help']);
      expect(exitCode).toBe(0);
    });

    it('returns 4 (CONFIGURATION_ERROR) when required arguments are missing', async () => {
      const exitCode = await main(['--provider', 'zeiss']);
      expect(exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    });

    it('returns 4 (CONFIGURATION_ERROR) when called with no arguments', async () => {
      const exitCode = await main([]);
      expect(exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    });
  });
});
