import { VouchersProvider } from '../../src/providers/vouchers';
import { ZeissApiClient } from '../../src/config/client';
import { zeissConfig } from '../../src/config/config';

describe('VouchersProvider Unit Tests', () => {
  let provider: VouchersProvider;

  beforeEach(() => {
    provider = new VouchersProvider();
    jest.spyOn(ZeissApiClient.prototype, 'fetch').mockClear();
    process.env.ZEISS_COUNTRY_ID = 'BR';
    process.env.ZEISS_STORE_ID = 'S1';
  });

  it('CAM-001: should return campaigns array directly', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce([{ id: 'C1' }]);
    const result = await provider.getCampaigns();
    expect(result).toEqual([{ id: 'C1' }]);
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.campaignsBaseUrl, '/prd/campanhas/bff/list/ativas/S1/BR', expect.anything());
  });

  it('LEAD-001: should get leads correctly', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce([{ id: 'L1' }]);
    const result = await provider.getLeads('C1');
    expect(result).toEqual([{ id: 'L1' }]);
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.campaignsBaseUrl, '/prd/campanhas/leads/loja/S1/C1', expect.anything());
  });

  it('LEAD-002: should get redeemed leads correctly without CPF', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce([{ id: 'L1' }]);
    const result = await provider.getRedeemedLeads('C1');
    expect(result).toEqual([{ id: 'L1' }]);
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.campaignsBaseUrl, '/prd/campanhas/leads/resgatado/loja/S1/C1', expect.anything());
  });

  it('VCH-001: should fetch vouchers correctly', async () => {
    const mockFetch = jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce([{ code: 'V1' }]);
    const result = await provider.getVoucherDetail('C1', 'V1');
    expect(result).toEqual([{ code: 'V1' }]);
    expect(mockFetch).toHaveBeenCalledWith(zeissConfig.campaignsBaseUrl, '/prd/campanhas/voucher/details/C1/V1', expect.anything());
  });
});
