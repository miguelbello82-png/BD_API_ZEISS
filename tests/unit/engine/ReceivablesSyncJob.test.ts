import { ReceivablesSyncJob } from '../../../src/engine/jobs/ReceivablesSyncJob';
import { IReceivablesProvider } from '../../../src/contracts/providers';
import { IReceivablesRepository } from '../../../src/contracts/repositories';
import { ILogger } from '../../../src/observability/Logger';
import { IClock } from '../../../src/utils/Clock';
import { JobContext } from '../../../src/engine/JobRegistry';

class MockLogger implements ILogger {
  debug() {}
  info() {}
  warn() {}
  error() {}
}

class MockClock implements IClock {
  public currentTime = new Date('2026-08-25T00:00:00Z').getTime();
  now() { return this.currentTime; }
}

describe('ReceivablesSyncJob', () => {
  let provider: jest.Mocked<IReceivablesProvider>;
  let repo: jest.Mocked<IReceivablesRepository>;
  let clock: MockClock;
  let job: ReceivablesSyncJob;
  let context: JobContext;

  beforeEach(() => {
    provider = { getReceivables: jest.fn().mockResolvedValue([]) } as any;
    repo = { upsertMany: jest.fn().mockResolvedValue(undefined) } as any;
    clock = new MockClock();
    job = new ReceivablesSyncJob(provider, repo, new MockLogger(), clock);

    context = {
      provider: 'zeiss',
      domain: 'receivables',
      operation: 'sync',
      abortSignal: new AbortController().signal,
      policy: {
        provider: 'zeiss', domain: 'receivables', operation: 'sync', enabled: true,
        interval_seconds: 60, timeout_seconds: 60, lease_ttl_seconds: 120, max_retries: 0, retry_delay_seconds: 0,
        lookback_seconds: null,
        operation_config: { status: 'A', pedido: 'P', maxRangeDays: 30 }
      },
      lastSyncState: null
    };
  });

  it('fails with BOOTSTRAP_REQUIRED if cursor is missing', async () => {
    const result = await job.execute(context);
    console.log(JSON.stringify(result, null, 2)); expect(result.success).toBe(false);
    expect(result.error?.message).toContain('BOOTSTRAP_REQUIRED');
  });

  it('fails with CURSOR_ERROR if cursor is malformed JSON', async () => {
    context.lastSyncState = { cursor_value: '{ invalid }' } as any;
    const result = await job.execute(context);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('CURSOR_ERROR');
    expect(result.error?.message).toContain('malformed JSON');
  });

  it('fails with CURSOR_ERROR if cursor date is invalid', async () => {
    context.lastSyncState = { cursor_value: JSON.stringify({ lastEndDate: '2026-99-99' }) } as any;
    const result = await job.execute(context);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('CURSOR_ERROR');
  });

  it('blocks cursor advancement if zeiss returns an invalid date', async () => {
    context.lastSyncState = { cursor_value: JSON.stringify({ lastEndDate: '2026-01-01' }) } as any;
    
    // Valid object except emission_date is invalid
    provider.getReceivables.mockResolvedValue([
      {
        boleto: '12345',
        emissao: 'NOT_A_DATE',
        valor: '100.50'
      }
    ]);

    const result = await job.execute(context);
    
    // Result fails because mapper threw an error, incrementing errors counter
    expect(result.success).toBe(false);
    expect(result.metrics?.errors).toBe(1);
    expect(repo.upsertMany).toHaveBeenCalledWith([]); // None valid
  });

  it('blocks cursor advancement if zeiss returns another kind of invalid date', async () => {
    context.lastSyncState = { cursor_value: JSON.stringify({ lastEndDate: '2026-01-01' }) } as any;
    
    provider.getReceivables.mockResolvedValue([
      {
        boleto: '12345',
        vencimento: '25/13/2026', // invalid month
        valor: '100.50'
      }
    ]);

    const result = await job.execute(context);
    
    expect(result.success).toBe(false);
    expect(result.metrics?.errors).toBe(1);
  });

  it('advances cursor successfully with DD/MM/YYYY format dates', async () => {
    context.lastSyncState = { cursor_value: JSON.stringify({ lastEndDate: '2026-01-01' }) } as any;
    
    provider.getReceivables.mockResolvedValue([
      {
        boleto: '12345',
        emissao: '05/07/2026',
        vencimento: '04/08/2026',
        valor: '100.50'
      }
    ]);

    const result = await job.execute(context);
    
    expect(result.success).toBe(true);
    expect(result.metrics?.errors).toBe(0);
    expect(result.metrics?.synced).toBe(1);
    expect(repo.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        emission_date: '2026-07-05',
        due_date: '2026-08-04'
      })
    ]);
  });

  it('fails with CURSOR_ERROR if cursor lacks lastEndDate', async () => {
    context.lastSyncState = { cursor_value: JSON.stringify({ other: 123 }) } as any;
    const result = await job.execute(context);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('CURSOR_ERROR');
  });

  it('fails with CONFIGURATION_ERROR if status is missing', async () => {
    (context.policy.operation_config as any).status = '';
    const result = await job.execute(context);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('CONFIGURATION_ERROR');
  });

  it('calculates periodStart and bounded periodEnd correctly', async () => {
    context.lastSyncState = { cursor_value: JSON.stringify({ lastEndDate: '2026-07-01' }) } as any;
    const result = await job.execute(context);
    expect(result.success).toBe(true);
    // periodStart = 2026-07-01
    // maxRangeDays = 30 -> periodEnd = 2026-07-31
    expect(provider.getReceivables).toHaveBeenCalledWith('2026-07-01', '2026-07-31', 'A', 'P', context.abortSignal);
    expect(result.cursorValue).toBe(JSON.stringify({ lastEndDate: '2026-07-31' }));
  });

  it('bounds periodEnd to current date', async () => {
    // Current time is 2026-08-25
    context.lastSyncState = { cursor_value: JSON.stringify({ lastEndDate: '2026-08-10' }) } as any;
    const result = await job.execute(context);
    expect(result.success).toBe(true);
    // maxRangeDays = 30 -> 2026-09-09, bounded to 2026-08-25
    expect(provider.getReceivables).toHaveBeenCalledWith('2026-08-10', '2026-08-25', 'A', 'P', context.abortSignal);
    expect(result.cursorValue).toBe(JSON.stringify({ lastEndDate: '2026-08-25' }));
  });

  it('does not advance cursor on provider failure', async () => {
    context.lastSyncState = { cursor_value: JSON.stringify({ lastEndDate: '2026-07-01' }) } as any;
    provider.getReceivables.mockRejectedValue(new Error('Provider failed'));
    
    const result = await job.execute(context);
    expect(result.success).toBe(false);
    expect(result.cursorValue).toBeUndefined(); // Does not return a new cursor
  });
});
