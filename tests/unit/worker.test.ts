import { executeWorkerTick, buildCompositionRoot } from '../../src/worker';
import { IDatabaseExecutor } from '../../src/config/db';
import { ConsoleLogger } from '../../src/observability/Logger';
import { CentralMultiStoreScheduler } from '../../src/engine/CentralMultiStoreScheduler';

jest.mock('../../src/engine/CentralMultiStoreScheduler');

describe('Worker Entrypoint & Scheduler Selection (ML-003)', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let mockLogger: ConsoleLogger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = {
      query: jest.fn(),
      transaction: jest.fn()
    };
    mockLogger = new ConsoleLogger();
    jest.spyOn(mockLogger, 'info').mockImplementation(() => {});
    jest.spyOn(mockLogger, 'error').mockImplementation(() => {});
    jest.spyOn(mockLogger, 'warn').mockImplementation(() => {});
  });

  describe('Legacy Mode Execution (Default)', () => {
    it('should execute in legacy single-store mode by default when RUNTIME_MODE is unset', async () => {
      // Mock db queries required by composition root scheduler
      mockDb.query.mockResolvedValueOnce([
        {
          provider: 'zeiss',
          domain: 'orders',
          operation: 'hot',
          enabled: true,
          interval_seconds: 900,
          timeout_seconds: 120,
          lease_ttl_seconds: 300,
          max_retries: 2,
          retry_delay_seconds: 120
        }
      ]); // findEnabledByProvider
      mockDb.query.mockResolvedValueOnce([]); // stateRepo
      mockDb.query.mockResolvedValueOnce([{ acquired: false }]); // leaseRepo tryAcquire returns false to short-circuit

      const result = await executeWorkerTick(mockDb, undefined, mockLogger);

      expect(result.mode).toBe('legacy');
      expect(result.legacySuccess).toBe(true);
      expect(CentralMultiStoreScheduler).not.toHaveBeenCalled();
    });

    it('should execute in legacy mode when RUNTIME_MODE is explicitly "legacy"', async () => {
      mockDb.query.mockResolvedValueOnce([]); // no enabled policies
      const result = await executeWorkerTick(mockDb, 'legacy', mockLogger);

      expect(result.mode).toBe('legacy');
      expect(result.legacySuccess).toBe(true);
      expect(CentralMultiStoreScheduler).not.toHaveBeenCalled();
    });
  });

  describe('Multi-Store Mode Execution (CentralMultiStoreScheduler)', () => {
    it('should instantiate CentralMultiStoreScheduler and tick when RUNTIME_MODE is "multi_store"', async () => {
      const mockTickResult = {
        totalPolicies: 7,
        totalActiveStores: 2,
        executions: [
          {
            storeId: 'store-1',
            storeCode: 'store-01',
            provider: 'zeiss',
            domain: 'orders',
            operation: 'hot',
            result: 'EXECUTED_SUCCESS' as const
          }
        ]
      };

      (CentralMultiStoreScheduler as jest.Mock).mockImplementation(() => ({
        tick: jest.fn().mockResolvedValue(mockTickResult)
      }));

      const result = await executeWorkerTick(mockDb, 'multi_store', mockLogger);

      expect(result.mode).toBe('multi_store');
      expect(result.multiStoreResult).toEqual(mockTickResult);
      expect(CentralMultiStoreScheduler).toHaveBeenCalledTimes(1);
    });

    it('should handle case insensitivity in RUNTIME_MODE ("MULTI_STORE")', async () => {
      const mockTickResult = {
        totalPolicies: 5,
        totalActiveStores: 1,
        executions: []
      };

      (CentralMultiStoreScheduler as jest.Mock).mockImplementation(() => ({
        tick: jest.fn().mockResolvedValue(mockTickResult)
      }));

      const result = await executeWorkerTick(mockDb, 'MULTI_STORE', mockLogger);

      expect(result.mode).toBe('multi_store');
      expect(result.multiStoreResult).toEqual(mockTickResult);
    });
  });

  describe('buildCompositionRoot', () => {
    it('should build a valid legacy composition root', () => {
      const root = buildCompositionRoot(mockDb, mockLogger);
      expect(root).toBeDefined();
      expect(root.scheduler).toBeDefined();
      expect(root.registry).toBeDefined();
    });
  });
});
