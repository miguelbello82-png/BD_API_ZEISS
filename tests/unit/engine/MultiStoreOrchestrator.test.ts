import { MultiStoreOrchestrator } from '../../../src/engine/MultiStoreOrchestrator';
import { IStoreResolutionService } from '../../../src/core/StoreResolutionService';
import { IDatabaseExecutor } from '../../../src/config/db';
import { StoreZeissContext } from '../../../src/contracts/store';
import { ConsoleLogger } from '../../../src/observability/Logger';
import { IClock, ISleeper } from '../../../src/utils/Clock';

// Mock buildStoreCompositionRoot
jest.mock('../../../src/engine/StoreCompositionRoot', () => {
  return {
    buildStoreCompositionRoot: jest.fn(),
  };
});

import { buildStoreCompositionRoot } from '../../../src/engine/StoreCompositionRoot';

describe('MultiStoreOrchestrator Unit Tests', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let mockStoreService: jest.Mocked<IStoreResolutionService>;
  const mockBuild = buildStoreCompositionRoot as jest.MockedFunction<typeof buildStoreCompositionRoot>;

  const mockClock: IClock = { now: () => 1700000000000 };
  const mockSleeper: ISleeper = { sleep: jest.fn().mockResolvedValue(undefined) };

  const store1: StoreZeissContext = {
    storeId: 'store-1-uuid',
    organizationId: 'org-1-uuid',
    storeCode: 'store-1',
    orgCode: 'org-1',
    cnpj: '11111111111111',
    status: 'ready',
    saowebCode: '1001',
    zeissStoreCode: 'CN01',
    countryId: '1',
    voucherUserId: '1',
    finUserId: '1',
    apiKey: 'key-1',
  };

  const store2: StoreZeissContext = {
    storeId: 'store-2-uuid',
    organizationId: 'org-1-uuid',
    storeCode: 'store-2',
    orgCode: 'org-1',
    cnpj: '22222222222222',
    status: 'active',
    saowebCode: '1002',
    zeissStoreCode: 'CN02',
    countryId: '1',
    voucherUserId: '2',
    finUserId: '2',
    apiKey: 'key-2',
  };

  beforeEach(() => {
    mockDb = {} as any;
    mockStoreService = {
      resolveStore: jest.fn(),
      listEligibleStores: jest.fn(),
    };
    mockBuild.mockReset();
  });

  it('ticks all eligible stores and records outcomes', async () => {
    mockStoreService.listEligibleStores.mockResolvedValueOnce([store1, store2]);

    const mockScheduler1 = { tick: jest.fn().mockResolvedValue(undefined) };
    const mockScheduler2 = { tick: jest.fn().mockResolvedValue(undefined) };

    mockBuild
      .mockReturnValueOnce({ scheduler: mockScheduler1 } as any)
      .mockReturnValueOnce({ scheduler: mockScheduler2 } as any);

    const orchestrator = new MultiStoreOrchestrator(
      mockDb,
      mockStoreService,
      new ConsoleLogger(),
      mockClock,
      mockSleeper
    );

    const result = await orchestrator.tick();

    expect(result.totalStores).toBe(2);
    expect(result.successfulStores).toBe(2);
    expect(result.failedStores).toBe(0);

    expect(mockScheduler1.tick).toHaveBeenCalled();
    expect(mockScheduler2.tick).toHaveBeenCalled();
  });

  it('isolates store failure: error in store 1 does not halt store 2', async () => {
    mockStoreService.listEligibleStores.mockResolvedValueOnce([store1, store2]);

    const mockScheduler1 = { tick: jest.fn().mockRejectedValue(new Error('ZEISS API connection timeout')) };
    const mockScheduler2 = { tick: jest.fn().mockResolvedValue(undefined) };

    mockBuild
      .mockReturnValueOnce({ scheduler: mockScheduler1 } as any)
      .mockReturnValueOnce({ scheduler: mockScheduler2 } as any);

    const orchestrator = new MultiStoreOrchestrator(
      mockDb,
      mockStoreService,
      new ConsoleLogger(),
      mockClock,
      mockSleeper
    );

    const result = await orchestrator.tick();

    expect(result.totalStores).toBe(2);
    expect(result.successfulStores).toBe(1);
    expect(result.failedStores).toBe(1);

    expect(mockScheduler1.tick).toHaveBeenCalled();
    expect(mockScheduler2.tick).toHaveBeenCalled(); // Store 2 was still executed!
  });

  it('executes operation for a single specified store', async () => {
    mockStoreService.resolveStore.mockResolvedValueOnce(store1);

    const mockScheduler1 = {
      executeOperation: jest.fn().mockResolvedValue('EXECUTED_SUCCESS'),
    };
    mockBuild.mockReturnValueOnce({ scheduler: mockScheduler1 } as any);

    const orchestrator = new MultiStoreOrchestrator(
      mockDb,
      mockStoreService,
      new ConsoleLogger(),
      mockClock,
      mockSleeper
    );

    const result = await orchestrator.executeOperation('store-1', 'zeiss', 'orders', 'discovery');

    expect(result).toBe('EXECUTED_SUCCESS');
    expect(mockStoreService.resolveStore).toHaveBeenCalledWith('store-1');
    expect(mockScheduler1.executeOperation).toHaveBeenCalledWith(
      'zeiss',
      'orders',
      'discovery',
      undefined
    );
  });
});
