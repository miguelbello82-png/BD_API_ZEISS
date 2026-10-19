import {
  ContinentalReconciliationService,
  ReconciliationCriteria
} from '../../../src/core/ContinentalReconciliationService';
import { IDatabaseExecutor } from '../../../src/config/db';
import { ConsoleLogger } from '../../../src/observability/Logger';

describe('ContinentalReconciliationService Unit Tests (ML-003)', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let service: ContinentalReconciliationService;
  let logger: ConsoleLogger;

  const continentalCriteria: ReconciliationCriteria = {
    targetStoreId: '3cdde1d2-4461-475f-8faf-418bbb3790fd',
    storeCode: 'continental',
    saowebCode: '33417',
    cnpj: '48.310.092/0001-32'
  };

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
      transaction: jest.fn()
    };
    logger = new ConsoleLogger();
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    service = new ContinentalReconciliationService(mockDb, logger);
  });

  describe('Auditing Historical Orders (dryRun = true)', () => {
    it('should classify orders with matching SAOWEB code as CONFIRMED', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          order_id: 'order-1',
          order_number: 'ZEISS-001',
          status: 'FATURADO',
          entry_date: '2026-05-10',
          detail_id: 'detail-1',
          detail_codcli: '33417', // Matching SAOWEB
          fiscal_id: null,
          fiscal_cnpj: null
        }
      ]);

      const report = await service.auditHistoricalOrders(continentalCriteria, { dryRun: true });

      expect(report.totalAudited).toBe(1);
      expect(report.confirmedMatches).toBe(1);
      expect(report.inconclusiveCandidates).toBe(0);
      expect(report.conflictsCount).toBe(0);
      expect(report.dryRun).toBe(true);
      expect(report.executedMutations).toBe(0);
      expect(report.items[0].confidence).toBe('CONFIRMED');
      expect(report.items[0].recommendation).toBe('ATTRIBUTION_ELIGIBLE');
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('should classify orders with matching Fiscal CNPJ as CONFIRMED', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          order_id: 'order-2',
          order_number: 'ZEISS-002',
          status: 'FATURADO',
          entry_date: '2026-06-15',
          detail_id: null,
          detail_codcli: null,
          fiscal_id: 'fiscal-1',
          fiscal_cnpj: '48310092000132' // Matching CNPJ
        }
      ]);

      const report = await service.auditHistoricalOrders(continentalCriteria, { dryRun: true });

      expect(report.confirmedMatches).toBe(1);
      expect(report.items[0].confidence).toBe('CONFIRMED');
    });

    it('should classify orders without detail or fiscal document as INCONCLUSIVE', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          order_id: 'order-3',
          order_number: 'ZEISS-003',
          status: 'PENDENTE',
          entry_date: '2025-12-01',
          detail_id: null,
          detail_codcli: null,
          fiscal_id: null,
          fiscal_cnpj: null
        }
      ]);

      const report = await service.auditHistoricalOrders(continentalCriteria, { dryRun: true });

      expect(report.totalAudited).toBe(1);
      expect(report.confirmedMatches).toBe(0);
      expect(report.inconclusiveCandidates).toBe(1);
      expect(report.conflictsCount).toBe(0);
      expect(report.items[0].confidence).toBe('INCONCLUSIVE');
      expect(report.items[0].recommendation).toBe('QUARANTINE_LEGACY');
    });

    it('should classify orders with divergent SAOWEB or CNPJ as CONFLICT', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          order_id: 'order-4',
          order_number: 'ZEISS-004',
          status: 'FATURADO',
          entry_date: '2026-01-20',
          detail_id: 'detail-2',
          detail_codcli: '99999', // Divergent SAOWEB!
          fiscal_id: null,
          fiscal_cnpj: null
        }
      ]);

      const report = await service.auditHistoricalOrders(continentalCriteria, { dryRun: true });

      expect(report.totalAudited).toBe(1);
      expect(report.confirmedMatches).toBe(0);
      expect(report.inconclusiveCandidates).toBe(0);
      expect(report.conflictsCount).toBe(1);
      expect(report.items[0].confidence).toBe('CONFLICT');
      expect(report.items[0].recommendation).toBe('EXCEPTION_CONFLICT');
    });
  });

  describe('Execution Safety (dryRun = false)', () => {
    it('should reject execution without confirmAuthorization=true', async () => {
      mockDb.query.mockResolvedValueOnce([]);

      await expect(
        service.auditHistoricalOrders(continentalCriteria, { dryRun: false, confirmAuthorization: false })
      ).rejects.toThrow('confirmAuthorization=true is strictly required');
    });

    it('should execute updates ONLY for CONFIRMED items when confirmAuthorization=true', async () => {
      mockDb.query.mockResolvedValueOnce([
        {
          order_id: 'order-1',
          order_number: 'ZEISS-001',
          status: 'FATURADO',
          entry_date: '2026-05-10',
          detail_id: 'detail-1',
          detail_codcli: '33417', // CONFIRMED
          fiscal_id: null,
          fiscal_cnpj: null
        },
        {
          order_id: 'order-2',
          order_number: 'ZEISS-002',
          status: 'PENDENTE',
          entry_date: '2026-05-12',
          detail_id: null,
          detail_codcli: null, // INCONCLUSIVE
          fiscal_id: null,
          fiscal_cnpj: null
        }
      ]);

      const clientQueryMock = jest.fn().mockResolvedValue({});
      mockDb.transaction.mockImplementation(async (callback) => {
        return await callback({ query: clientQueryMock } as any);
      });

      const report = await service.auditHistoricalOrders(continentalCriteria, {
        dryRun: false,
        confirmAuthorization: true
      });

      expect(report.dryRun).toBe(false);
      expect(report.executedMutations).toBe(1);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(clientQueryMock).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE zeiss.orders'),
        [continentalCriteria.targetStoreId, 'order-1']
      );
    });
  });
});
