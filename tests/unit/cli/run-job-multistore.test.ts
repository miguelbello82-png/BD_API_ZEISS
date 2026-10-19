import { parseRunJobArgs, runJob, EXIT_CODES } from '../../../src/cli/run-job';
import { ILogger } from '../../../src/observability/Logger';
import { IDatabaseExecutor } from '../../../src/config/db';

jest.mock('../../../src/core/StoreResolutionService');
jest.mock('../../../src/engine/StoreCompositionRoot');

import { PgStoreResolutionService } from '../../../src/core/StoreResolutionService';
import { buildStoreCompositionRoot } from '../../../src/engine/StoreCompositionRoot';
import { StoreNotFoundError, StoreSuspendedError } from '../../../src/contracts/store';

describe('run-job Multi-Store CLI Tests', () => {
  let mockLogger: ILogger;
  let mockDb: IDatabaseExecutor;
  let mockScheduler: any;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockDb = {} as any;
    mockScheduler = {
      executeOperation: jest.fn().mockResolvedValue('EXECUTED_SUCCESS'),
    };
  });

  describe('parseRunJobArgs', () => {
    it('parses --store <value>', () => {
      const args = parseRunJobArgs(['--provider', 'zeiss', '--domain', 'orders', '--operation', 'discovery', '--store', 'continental']);
      expect(args.store).toBe('continental');
    });

    it('parses --store=<value>', () => {
      const args = parseRunJobArgs(['--provider', 'zeiss', '--domain', 'orders', '--operation', 'discovery', '--store=3cdde1d2-4461-475f-8faf-418bbb3790fd']);
      expect(args.store).toBe('3cdde1d2-4461-475f-8faf-418bbb3790fd');
    });

    it('parses --legacy flag', () => {
      const args = parseRunJobArgs(['--provider', 'zeiss', '--domain', 'orders', '--operation', 'discovery', '--legacy']);
      expect(args.legacy).toBe(true);
    });
  });

  describe('runJob execution in store context', () => {
    it('executes job in store context when --store is provided', async () => {
      const mockResolveStore = jest.fn().mockResolvedValue({
        storeId: '3cdde1d2-4461-475f-8faf-418bbb3790fd',
        storeCode: 'continental',
      });
      (PgStoreResolutionService as jest.Mock).mockImplementation(() => ({
        resolveStore: mockResolveStore,
      }));

      const mockStoreScheduler = {
        executeOperation: jest.fn().mockResolvedValue('EXECUTED_SUCCESS'),
      };
      (buildStoreCompositionRoot as jest.Mock).mockReturnValue({
        scheduler: mockStoreScheduler,
      });

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'orders',
          operation: 'discovery',
          store: 'continental',
          allowDisabled: false,
          force: true,
          help: false,
          legacy: false,
        },
        { logger: mockLogger, db: mockDb }
      );

      expect(result).toBe('EXECUTED_SUCCESS');
      expect(exitCode).toBe(EXIT_CODES.EXECUTED_SUCCESS);
      expect(mockResolveStore).toHaveBeenCalledWith('continental');
      expect(mockStoreScheduler.executeOperation).toHaveBeenCalledWith(
        'zeiss',
        'orders',
        'discovery',
        { allowDisabled: false, force: true }
      );
    });

    it('returns CONFIGURATION_ERROR (exit code 4) when store is not found', async () => {
      (PgStoreResolutionService as jest.Mock).mockImplementation(() => ({
        resolveStore: jest.fn().mockRejectedValue(new StoreNotFoundError('non-existent')),
      }));

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'orders',
          operation: 'discovery',
          store: 'non-existent',
          allowDisabled: false,
          force: true,
          help: false,
          legacy: false,
        },
        { logger: mockLogger, db: mockDb }
      );

      expect(result).toBe('CONFIGURATION_ERROR');
      expect(exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    });

    it('returns SKIPPED_DISABLED (exit code 3) when store is suspended', async () => {
      (PgStoreResolutionService as jest.Mock).mockImplementation(() => ({
        resolveStore: jest.fn().mockRejectedValue(new StoreSuspendedError('continental', 'uuid-1')),
      }));

      const { result, exitCode } = await runJob(
        {
          provider: 'zeiss',
          domain: 'orders',
          operation: 'discovery',
          store: 'continental',
          allowDisabled: false,
          force: true,
          help: false,
          legacy: false,
        },
        { logger: mockLogger, db: mockDb }
      );

      expect(result).toBe('SKIPPED_DISABLED');
      expect(exitCode).toBe(EXIT_CODES.SKIPPED_DISABLED);
    });

    it('rejects unscoped execution in multi_store mode without --store or --legacy', async () => {
      const originalRuntimeMode = process.env.RUNTIME_MODE;
      process.env.RUNTIME_MODE = 'multi_store';

      try {
        const { result, exitCode } = await runJob(
          {
            provider: 'zeiss',
            domain: 'orders',
            operation: 'discovery',
            allowDisabled: false,
            force: true,
            help: false,
            legacy: false,
          },
          { logger: mockLogger, scheduler: mockScheduler }
        );

        expect(result).toBe('CONFIGURATION_ERROR');
        expect(exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
        expect(mockLogger.error).toHaveBeenCalledWith(
          'run-job',
          expect.stringContaining('In multi_store mode, --store <code|uuid> is required')
        );
      } finally {
        process.env.RUNTIME_MODE = originalRuntimeMode;
      }
    });

    it('allows unscoped execution in multi_store mode when --legacy is passed', async () => {
      const originalRuntimeMode = process.env.RUNTIME_MODE;
      process.env.RUNTIME_MODE = 'multi_store';

      try {
        const { result, exitCode } = await runJob(
          {
            provider: 'zeiss',
            domain: 'orders',
            operation: 'discovery',
            allowDisabled: false,
            force: true,
            help: false,
            legacy: true,
          },
          { logger: mockLogger, scheduler: mockScheduler }
        );

        expect(result).toBe('EXECUTED_SUCCESS');
        expect(exitCode).toBe(EXIT_CODES.EXECUTED_SUCCESS);
        expect(mockScheduler.executeOperation).toHaveBeenCalled();
      } finally {
        process.env.RUNTIME_MODE = originalRuntimeMode;
      }
    });
  });
});
