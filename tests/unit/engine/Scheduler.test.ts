import { Scheduler, SchedulerDeps } from '../../../src/engine/Scheduler';
import { JobRegistry, IJob, JobResult, JobContext } from '../../../src/engine/JobRegistry';
import {
  ISyncPolicyRepository,
  ISyncStateRepository,
  ISyncLeaseRepository,
  IProviderHealthRepository,
  SyncPolicy,
  SyncState
} from '../../../src/contracts/repositories';
import { IClock, ISleeper } from '../../../src/utils/Clock';
import { NullLogger } from '../../../src/observability/Logger';

function buildMockDeps(): jest.Mocked<SchedulerDeps> {
  return {
    policyRepo: {
      findAll: jest.fn(),
      findAllEnabled: jest.fn().mockResolvedValue([mockPolicy]),
      findEnabledByProvider: jest.fn().mockResolvedValue([]),
      findByKey: jest.fn(),
      upsert: jest.fn(),
      enable: jest.fn(),
      disable: jest.fn()
    } as any,
    stateRepo: {
      findByKey: jest.fn().mockResolvedValue(null),
      upsert: jest.fn()
    } as any,
    leaseRepo: {
      tryAcquire: jest.fn().mockResolvedValue({ acquired: true }),
      release: jest.fn(),
      renew: jest.fn().mockResolvedValue(true),
      findActive: jest.fn()
    } as any,
    healthRepo: {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      findByKey: jest.fn()
    } as any,
    jobRegistry: new JobRegistry() as any,
    logger: new NullLogger() as any,
    clock: { now: jest.fn().mockReturnValue(Date.now()) } as any,
    sleeper: { sleep: jest.fn().mockImplementation((ms) => new Promise(resolve => setTimeout(resolve, ms || 1))) } as any
  };
}

const mockPolicy: SyncPolicy = {
  provider: 'zeiss',
  domain: 'orders',
  operation: 'discovery',
  enabled: true,
  interval_seconds: 60,
  lookback_seconds: null,
  timeout_seconds: 1, // short timeout for testing
  lease_ttl_seconds: 120,
  max_retries: 2,
  retry_delay_seconds: 0
};

describe('Scheduler', () => {
  let deps: jest.Mocked<SchedulerDeps>;
  let scheduler: Scheduler;

  beforeEach(() => {
    deps = buildMockDeps();
    scheduler = new Scheduler(deps);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does nothing if no policies enabled', async () => {
    (deps.policyRepo.findAllEnabled as jest.Mock).mockResolvedValue([]);
    await scheduler.tick();
    expect(deps.stateRepo.findByKey).not.toHaveBeenCalled();
  });

  it('skips execution if not due', async () => {
    (deps.policyRepo.findEnabledByProvider as jest.Mock).mockResolvedValue([mockPolicy]);
    (deps.stateRepo.findByKey as jest.Mock).mockResolvedValue({
      provider: 'zeiss',
      domain: 'orders',
      operation: 'discovery',
      last_sync: new Date(), // just ran
      cursor_value: null
    });

    await scheduler.tick();

    expect(deps.leaseRepo.tryAcquire).not.toHaveBeenCalled();
  });

  it('skips execution if lease is unavailable', async () => {
    (deps.policyRepo.findEnabledByProvider as jest.Mock).mockResolvedValue([mockPolicy]);
    (deps.stateRepo.findByKey as jest.Mock).mockResolvedValue(null); // due
    (deps.leaseRepo.tryAcquire as jest.Mock).mockResolvedValue({ acquired: false });

    await scheduler.tick();

    expect(deps.leaseRepo.release).not.toHaveBeenCalled(); // We didn't acquire it, we shouldn't release it
    expect(deps.healthRepo.recordSuccess).not.toHaveBeenCalled();
  });

  it('fails if job is not in registry', async () => {
    (deps.policyRepo.findEnabledByProvider as jest.Mock).mockResolvedValue([mockPolicy]);
    
    // No job registered!
    await scheduler.tick();

    expect(deps.healthRepo.recordFailure).toHaveBeenCalled();
    expect(deps.leaseRepo.release).toHaveBeenCalled();
  });

  it('executes job and updates state on success', async () => {
    (deps.policyRepo.findEnabledByProvider as jest.Mock).mockResolvedValue([mockPolicy]);
    
    const mockJob: IJob = {
      execute: jest.fn().mockResolvedValue({ success: true, cursorValue: 'new_cursor' })
    };
    deps.jobRegistry.get = jest.fn().mockReturnValue(mockJob);

    await scheduler.tick();

    expect(mockJob.execute).toHaveBeenCalled();
    expect(deps.healthRepo.recordSuccess).toHaveBeenCalled();
    expect(deps.stateRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ cursor_value: 'new_cursor' }));
    expect(deps.leaseRepo.release).toHaveBeenCalled();
  });

  it('records failure and does NOT advance state on job failure', async () => {
    (deps.policyRepo.findEnabledByProvider as jest.Mock).mockResolvedValue([mockPolicy]);
    
    const mockJob: IJob = {
      execute: jest.fn().mockResolvedValue({ success: false, error: new Error('boom') })
    };
    deps.jobRegistry.get = jest.fn().mockReturnValue(mockJob);

    await scheduler.tick();

    expect(deps.healthRepo.recordFailure).toHaveBeenCalled();
    expect(deps.stateRepo.upsert).not.toHaveBeenCalled(); // no advance
    expect(deps.leaseRepo.release).toHaveBeenCalled(); // lease released anyway
  });

  it('retries on exception up to max_retries', async () => {
    (deps.policyRepo.findEnabledByProvider as jest.Mock).mockResolvedValue([mockPolicy]);
    
    let calls = 0;
    const mockJob: IJob = {
      execute: jest.fn().mockImplementation(() => {
        calls++;
        throw new Error('Temporary glitch');
      })
    };
    deps.jobRegistry.get = jest.fn().mockReturnValue(mockJob);

    await scheduler.tick();

    // 1 initial + max_retries(2) = 3 calls
    expect(calls).toBe(3);
    expect(deps.healthRepo.recordFailure).toHaveBeenCalled();
  });

  it('handles job timeout', async () => {
    const fastPolicy = { ...mockPolicy, timeout_seconds: 0.01 };
    (deps.policyRepo.findEnabledByProvider as jest.Mock).mockResolvedValue([fastPolicy]);
    
    const mockJob: IJob = {
      execute: jest.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100))) // longer than timeout_seconds(0.01)
    };
    deps.jobRegistry.get = jest.fn().mockReturnValue(mockJob);

    await scheduler.tick();

    expect(deps.healthRepo.recordFailure).toHaveBeenCalled();
    expect(deps.leaseRepo.release).toHaveBeenCalled(); // releases lease even on timeout
  });

  it('does not advance state if ownership is lost during execution', async () => {
    (deps.policyRepo.findEnabledByProvider as jest.Mock).mockResolvedValue([mockPolicy]);
    const mockJob = {
      execute: jest.fn().mockResolvedValue({ success: true, cursorValue: 'new_cursor' })
    };
    deps.jobRegistry.get = jest.fn().mockReturnValue(mockJob);
    // Mock renew to return false when proving ownership
    (deps.leaseRepo.renew as jest.Mock).mockResolvedValue(false);

    await scheduler.tick();

    expect(deps.stateRepo.upsert).not.toHaveBeenCalled();
    expect(deps.healthRepo.recordFailure).toHaveBeenCalled();
  });

  it('passes operation_config to JobContext', async () => {
    const configPolicy = { ...mockPolicy, operation_config: { maxRangeDays: 15 } };
    (deps.policyRepo.findEnabledByProvider as jest.Mock).mockResolvedValue([configPolicy]);
    
    let contextConfig: any = null;
    const mockJob: IJob = {
      execute: jest.fn().mockImplementation(async (context: JobContext) => {
        contextConfig = context.policy.operation_config;
        return { success: true, cursorValue: null };
      })
    };
    deps.jobRegistry.get = jest.fn().mockReturnValue(mockJob);

    await scheduler.tick('zeiss');

    expect(mockJob.execute).toHaveBeenCalled();
    expect(contextConfig).toEqual({ maxRangeDays: 15 });
  });
});
