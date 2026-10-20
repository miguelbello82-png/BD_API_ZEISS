import { ZeissApiClient } from '../config/client';
import { zeissConfig } from '../config/config';
import { StoreZeissContext } from '../contracts/store';

export class VouchersProvider {
  private client: ZeissApiClient;

  constructor(
    private storeContext?: StoreZeissContext,
    client?: ZeissApiClient
  ) {
    this.client = client || new ZeissApiClient();
  }

  // CAM-001
  async getCampaigns(abortSignal?: AbortSignal, contextOverride?: Partial<StoreZeissContext>) {
    const storeId = contextOverride?.zeissStoreCode || this.storeContext?.zeissStoreCode || zeissConfig.storeId;
    const countryId = contextOverride?.countryId || this.storeContext?.countryId || zeissConfig.countryId;
    const baseUrl = contextOverride?.campaignsBaseUrl || this.storeContext?.campaignsBaseUrl || zeissConfig.campaignsBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/campanhas/bff/list/ativas/${storeId}/${countryId}`;
    const res = await this.client.fetch<unknown>(baseUrl, path, { signal: abortSignal, apiKey });
    if (!Array.isArray(res)) {
      throw new Error('ZEISS API Contract Error: Expected an array for campaigns');
    }
    return res;
  }

  // LEAD-001
  async getLeads(campaignId: string, abortSignal?: AbortSignal, contextOverride?: Partial<StoreZeissContext>): Promise<Record<string, unknown>[]> {
    const storeId = contextOverride?.zeissStoreCode || this.storeContext?.zeissStoreCode || zeissConfig.storeId;
    const baseUrl = contextOverride?.campaignsBaseUrl || this.storeContext?.campaignsBaseUrl || zeissConfig.campaignsBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/campanhas/leads/loja/${storeId}/${campaignId}`;
    const rawRes = await this.client.fetch<unknown>(baseUrl, path, { signal: abortSignal, apiKey });

    if (Array.isArray(rawRes)) {
      return rawRes;
    }

    if (
      rawRes &&
      typeof rawRes === 'object' &&
      'dados' in rawRes &&
      Array.isArray((rawRes as any).dados) &&
      'resumo' in rawRes &&
      typeof (rawRes as any).resumo === 'object' &&
      (rawRes as any).resumo !== null
    ) {
      return (rawRes as any).dados;
    }

    return rawRes as any;
  }

  // LEAD-002
  async getRedeemedLeads(campaignId: string, abortSignal?: AbortSignal, contextOverride?: Partial<StoreZeissContext>) {
    const storeId = contextOverride?.zeissStoreCode || this.storeContext?.zeissStoreCode || zeissConfig.storeId;
    const baseUrl = contextOverride?.campaignsBaseUrl || this.storeContext?.campaignsBaseUrl || zeissConfig.campaignsBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/campanhas/leads/resgatado/loja/${storeId}/${campaignId}`;
    return await this.client.fetch<Record<string, unknown>[]>(baseUrl, path, { signal: abortSignal, apiKey });
  }

  // VCH-001
  async getVoucherDetail(campaignId: string, voucherCode: string, abortSignal?: AbortSignal, contextOverride?: Partial<StoreZeissContext>) {
    const baseUrl = contextOverride?.campaignsBaseUrl || this.storeContext?.campaignsBaseUrl || zeissConfig.campaignsBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/campanhas/voucher/details/${campaignId}/${voucherCode}`;
    return await this.client.fetch<Record<string, unknown>[]>(baseUrl, path, { signal: abortSignal, apiKey });
  }

  // VCH-002
  async generateVoucher(payload: Record<string, unknown>, contextOverride?: Partial<StoreZeissContext>) {
    if (process.env.ALLOW_EXTERNAL_MUTATIONS !== 'true') {
      throw new Error('EXTERNAL MUTATIONS ARE DISABLED. Set ALLOW_EXTERNAL_MUTATIONS=true to execute.');
    }
    const baseUrl = contextOverride?.campaignsBaseUrl || this.storeContext?.campaignsBaseUrl || zeissConfig.campaignsBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/campanhas/voucher/generate`;
    return await this.client.fetch<Record<string, unknown>>(baseUrl, path, {
      method: 'POST',
      body: JSON.stringify(payload),
      apiKey
    });
  }

  // VCH-003
  async activateVoucher(campaignId: string, voucherCode: string, contextOverride?: Partial<StoreZeissContext>) {
    if (process.env.ALLOW_EXTERNAL_MUTATIONS !== 'true') {
      throw new Error('EXTERNAL MUTATIONS ARE DISABLED.');
    }
    const storeId = contextOverride?.zeissStoreCode || this.storeContext?.zeissStoreCode || zeissConfig.storeId;
    const voucherUserId = contextOverride?.voucherUserId || this.storeContext?.voucherUserId || zeissConfig.voucherUserId;
    const baseUrl = contextOverride?.campaignsBaseUrl || this.storeContext?.campaignsBaseUrl || zeissConfig.campaignsBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/campanhas/voucher/redeem`;
    return await this.client.fetch<Record<string, unknown>>(baseUrl, path, {
      method: 'POST',
      body: JSON.stringify({
        idcampaign: campaignId,
        vouchercode: voucherCode,
        iduser: voucherUserId,
        cnloja: storeId
      }),
      apiKey
    });
  }
}
