import { PgSyncLeaseRepository } from '../../../../src/repositories/postgres/SyncLeaseRepository';
import { IDatabaseExecutor } from '../../../../src/config/db';
import { QueryResultRow } from 'pg';

describe('PgSyncLeaseRepository', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let repo: PgSyncLeaseRepository;

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
      transaction: jest.fn(async (cb) => await cb(mockDb))
    } as any;
    repo = new PgSyncLeaseRepository(mockDb);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('tryAcquire returns true when lease is acquired', async () => {
    mockDb.query.mockResolvedValueOnce([{ acquired: true }]); // returning one row
    const result = await repo.tryAcquire('zeiss', 'orders', 'discovery', 'token1', 120);
    
    expect(result.acquired).toBe(true);
    const queryArg = (mockDb.query as jest.Mock).mock.calls[0][0];
    expect(queryArg).toContain('INSERT INTO integration.sync_leases');
    expect(queryArg).toContain('ON CONFLICT (provider, domain, operation)');
    expect(queryArg).toContain('WHERE integration.sync_leases.expires_at < CURRENT_TIMESTAMP');
    expect((mockDb.query as jest.Mock).mock.calls[0][1]).toEqual(['zeiss', 'orders', 'discovery', 'token1', 120]);
  });

  it('tryAcquire returns false when lease is actively held by someone else', async () => {
    mockDb.query.mockResolvedValueOnce([]); // no rows returned
    const result = await repo.tryAcquire('zeiss', 'orders', 'discovery', 'token2', 120);
    
    expect(result.acquired).toBe(false);
  });

  it('release executes delete with correct owner token', async () => {
    mockDb.query.mockResolvedValueOnce([{ id: 'fake_id' }]);
    const result = await repo.release('zeiss', 'orders', 'discovery', 'token1');
    
    expect(result).toBeUndefined();
    expect((mockDb.query as jest.Mock).mock.calls[0][1]).toEqual(['zeiss', 'orders', 'discovery', 'token1']);
  });
});
