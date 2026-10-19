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

  describe('LEAD-001 adapter tests', () => {
    it('1. direct array response -> accepted', async () => {
      jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce([{ id: 'L1' }]);
      const result = await provider.getLeads('C1');
      expect(result).toEqual([{ id: 'L1' }]);
    });

    it('2. valid { resumo, dados } -> accepted', async () => {
      jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce({
        resumo: { total_leads: 1 },
        dados: [{ id: 'L1' }]
      });
      const result = await provider.getLeads('C1');
      expect(result).toEqual([{ id: 'L1' }]);
    });

    it('3. valid { resumo, dados: [] } -> accepted', async () => {
      jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce({
        resumo: { total_leads: 0 },
        dados: []
      });
      const result = await provider.getLeads('C1');
      expect(result).toEqual([]);
    });

    it('4. missing dados -> rejected', async () => {
      const raw = { resumo: { total_leads: 1 }, items: [{ id: 'L1' }] };
      jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce(raw);
      const result = await provider.getLeads('C1');
      expect(result).toEqual(raw);
    });

    it('5. dados not array -> rejected', async () => {
      const raw = { resumo: { total_leads: 1 }, dados: { id: 'L1' } };
      jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce(raw);
      const result = await provider.getLeads('C1');
      expect(result).toEqual(raw);
    });

    it('6. missing/invalid resumo -> rejected', async () => {
      const raw = { dados: [{ id: 'L1' }] };
      jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce(raw);
      const result = await provider.getLeads('C1');
      expect(result).toEqual(raw);
    });

    it('7. unrelated object -> rejected', async () => {
      const raw = { status: 'ok' };
      jest.spyOn(ZeissApiClient.prototype, 'fetch').mockResolvedValueOnce(raw);
      const result = await provider.getLeads('C1');
      expect(result).toEqual(raw);
    });
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
