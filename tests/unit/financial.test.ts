import { FinancialProvider } from '../../src/providers/financial';
import { ZeissApiClient } from '../../src/config/client';
import { zeissConfig } from '../../src/config/config';

describe('FinancialProvider Unit Tests', () => {
  let provider: FinancialProvider;

  beforeEach(() => {
    provider = new FinancialProvider();
    jest.spyOn(ZeissApiClient.prototype, 'fetch').mockClear();
    process.env.ZEISS_COUNTRY_ID = 'BR';
    process.env.ZEISS_STORE_ID = 'S1';
    process.env.ZEISS_FIN_USER_ID = 'F1';
  });

  it('FIN-001: should fetch receivables with parameterized path', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce([{ id: 'F1' }]);
    const result = await provider.getReceivables('start', 'end', 'status', 'ped1');
    expect(result).toEqual([{ id: 'F1' }]);
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.financialBaseUrl, '/prd/financial/receivable/S1/start/end/status/ped1/BR', expect.anything());
  });

  it('FIN-002: should fetch single receivable including dueDate', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce({ id: 'F1', dueDate: '2023-12-01' });
    const result = await provider.getBoleto('B1', '2023-12-01');
    expect(result).toEqual({ id: 'F1', dueDate: '2023-12-01' });
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.financialBaseUrl, '/prd/financial/receivable/boletourl/B1/2023-12-01/S1/F1', expect.anything());
  });

  it('FIN-003: should fetch xml with contractual formatting', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce({ xml: '<doc/>' });
    const result = await provider.getDanfe('N1', 'SER1');
    expect(result).toEqual({ xml: '<doc/>' });
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.ordersBaseUrl, '/prd/pedidos/nf/BR/S1/000000N1SER1');
  });
});
