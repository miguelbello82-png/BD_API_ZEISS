import { LeadsSyncJob } from '../../../src/engine/jobs/LeadsSyncJob';
import { LeadsRedeemedSyncJob } from '../../../src/engine/jobs/LeadsRedeemedSyncJob';
import { JobContext } from '../../../src/engine/JobRegistry';
import { ILeadsProvider } from '../../../src/contracts/providers';
import { ISyncStateRepository, ILeadsRepository } from '../../../src/contracts/repositories';
import { ILogger } from '../../../src/observability/Logger';

describe('Leads Sync Jobs - Snapshot Preconditions', () => {
  let mockProvider: jest.Mocked<ILeadsProvider>;
  let mockStateRepo: jest.Mocked<ISyncStateRepository>;
  let mockLeadsRepo: jest.Mocked<ILeadsRepository>;
  let mockLogger: jest.Mocked<ILogger>;
  let context: JobContext;

  beforeEach(() => {
    mockProvider = {
      getLeads: jest.fn(),
      getRedeemedLeads: jest.fn()
    } as any;

    mockStateRepo = {
      findByKey: jest.fn(),
      upsertState: jest.fn()
    } as any;

    mockLeadsRepo = {
      upsertMany: jest.fn(),
      upsertRedeemedMany: jest.fn()
    } as any;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    };

    context = {
      abortSignal: { aborted: false }
    } as any;
  });

  const testCases = [
    { name: 'LeadsSyncJob', JobClass: LeadsSyncJob },
    { name: 'LeadsRedeemedSyncJob', JobClass: LeadsRedeemedSyncJob }
  ];

  testCases.forEach(({ name, JobClass }) => {
    describe(name, () => {
      let job: LeadsSyncJob | LeadsRedeemedSyncJob;

      beforeEach(() => {
        job = new JobClass(mockProvider, mockStateRepo, mockLeadsRepo, mockLogger);
      });

      it('should fail explicitly if state/cursor is missing', async () => {
        mockStateRepo.findByKey.mockResolvedValueOnce(null);
        
        const result = await job.execute(context);
        
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('BOOTSTRAP_REQUIRED: Missing CAM-001 successful snapshot in sync_state');
        expect(mockProvider.getLeads).not.toHaveBeenCalled();
        expect(mockProvider.getRedeemedLeads).not.toHaveBeenCalled();
      });

      it('should fail explicitly if cursor_value is not valid JSON', async () => {
        mockStateRepo.findByKey.mockResolvedValueOnce({
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          cursor_value: 'not-a-json'
        } as any);
        
        const result = await job.execute(context);
        
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('BOOTSTRAP_REQUIRED: Malformed CAM-001 snapshot in sync_state');
        expect(mockProvider.getLeads).not.toHaveBeenCalled();
        expect(mockProvider.getRedeemedLeads).not.toHaveBeenCalled();
      });

      it('should fail explicitly if activeCampaignIds is missing or not an array', async () => {
        mockStateRepo.findByKey.mockResolvedValueOnce({
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          cursor_value: JSON.stringify({ someOtherField: true })
        } as any);
        
        const result = await job.execute(context);
        
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('BOOTSTRAP_REQUIRED: Malformed CAM-001 snapshot in sync_state');
        expect(mockProvider.getLeads).not.toHaveBeenCalled();
        expect(mockProvider.getRedeemedLeads).not.toHaveBeenCalled();
      });

      it('should execute successfully with 0 items if activeCampaignIds is an empty array', async () => {
        mockStateRepo.findByKey.mockResolvedValueOnce({
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          cursor_value: JSON.stringify({ activeCampaignIds: [] })
        } as any);
        
        const result = await job.execute(context);
        
        expect(result.success).toBe(true);
        expect(result.metrics?.synced).toBe(0);
        expect(result.metrics?.errors).toBe(0);
        expect(mockProvider.getLeads).not.toHaveBeenCalled();
        expect(mockProvider.getRedeemedLeads).not.toHaveBeenCalled();
      });

      it('should process dynamically if activeCampaignIds has values', async () => {
        mockStateRepo.findByKey.mockResolvedValueOnce({
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          cursor_value: JSON.stringify({ activeCampaignIds: ['C1', 'C2'] })
        } as any);

        mockProvider.getLeads.mockResolvedValue([]);
        mockProvider.getRedeemedLeads.mockResolvedValue([]);

        const result = await job.execute(context);
        
        expect(result.success).toBe(true);
        if (name === 'LeadsSyncJob') {
          expect(mockProvider.getLeads).toHaveBeenCalledTimes(2);
          expect(mockProvider.getLeads).toHaveBeenCalledWith('C1', context.abortSignal);
          expect(mockProvider.getLeads).toHaveBeenCalledWith('C2', context.abortSignal);
        } else {
          expect(mockProvider.getRedeemedLeads).toHaveBeenCalledTimes(2);
          expect(mockProvider.getRedeemedLeads).toHaveBeenCalledWith('C1', context.abortSignal);
          expect(mockProvider.getRedeemedLeads).toHaveBeenCalledWith('C2', context.abortSignal);
        }
      });
      it('should handle real HTTP 404 on LEAD-001 by logging and continuing, but propagate on LEAD-002', async () => {
        mockStateRepo.findByKey.mockResolvedValueOnce({
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          cursor_value: JSON.stringify({ activeCampaignIds: ['C1'] })
        } as any);

        const http404Error = new Error('ZEISS API Error: 404 Not Found - ') as any;
        http404Error.name = 'ZeissHttpError';
        http404Error.status = 404;

        if (name === 'LeadsSyncJob') {
          mockProvider.getLeads.mockRejectedValue(http404Error);
          const result = await job.execute(context);
          expect(result.success).toBe(true);
          expect(mockLogger.info).toHaveBeenCalledWith(
            'LeadsSyncJob',
            'Campaign not found or without leads (404)',
            { campaignId: 'C1' }
          );
        } else {
          mockProvider.getRedeemedLeads.mockRejectedValue(http404Error);
          const result = await job.execute(context);
          expect(result.success).toBe(false);
          expect(mockLogger.error).toHaveBeenCalled();
        }
      });

      it('should propagate non-HTTP errors containing 404', async () => {
        mockStateRepo.findByKey.mockResolvedValueOnce({
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          cursor_value: JSON.stringify({ activeCampaignIds: ['C1'] })
        } as any);

        const nonHttpError = new Error('Some random error 404');
        mockProvider.getLeads.mockRejectedValue(nonHttpError);
        mockProvider.getRedeemedLeads.mockRejectedValue(nonHttpError);

        const result = await job.execute(context);
        expect(result.success).toBe(false);
      });

      it('should propagate 401, 403, 429, 5xx timeouts', async () => {
        const errors = [401, 403, 429, 500, 503];
        for (const status of errors) {
          mockStateRepo.findByKey.mockResolvedValueOnce({
            provider: 'zeiss',
            domain: 'campaigns',
            operation: 'sync',
            cursor_value: JSON.stringify({ activeCampaignIds: ['C1'] })
          } as any);

          const err = new Error(`ZEISS API Error: ${status}`) as any;
          err.name = 'ZeissHttpError';
          err.status = status;

          mockProvider.getLeads.mockRejectedValueOnce(err);
          mockProvider.getRedeemedLeads.mockRejectedValueOnce(err);

          const result = await job.execute(context);
          expect(result.success).toBe(false);
        }
      });

      it('should gracefully handle valid HTTP 200 with invalid payload by mapping to null and ignoring', async () => {
        mockStateRepo.findByKey.mockResolvedValueOnce({
          provider: 'zeiss',
          domain: 'campaigns',
          operation: 'sync',
          cursor_value: JSON.stringify({ activeCampaignIds: ['C1'] })
        } as any);

        // Invalid payload element
        mockProvider.getLeads.mockResolvedValue([{ invalid: true }]);
        mockProvider.getRedeemedLeads.mockResolvedValue([{ invalid: true }]);

        const result = await job.execute(context);
        expect(result.success).toBe(false); // Because errors++ is incremented on mapping failure
        expect(result.metrics?.errors).toBe(1);
      });
    });
  });
});
