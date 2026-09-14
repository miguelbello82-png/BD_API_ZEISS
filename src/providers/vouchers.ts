import { ZeissApiClient } from '../config/client';
import { zeissConfig } from '../config/config';

export class VouchersProvider {
  private client: ZeissApiClient;

  constructor() {
    this.client = new ZeissApiClient();
  }

  // CAM-001
  async getCampaigns(abortSignal?: AbortSignal) {
    const path = `/prd/campanhas/bff/list/ativas/${zeissConfig.storeId}/${zeissConfig.countryId}`;
    const res = await this.client.fetch<unknown>(zeissConfig.campaignsBaseUrl, path, { signal: abortSignal });
    if (!Array.isArray(res)) {
      throw new Error('ZEISS API Contract Error: Expected an array for campaigns');
    }
    return res;
  }

  // LEAD-001
  async getLeads(campaignId: string, abortSignal?: AbortSignal) {
    const path = `/prd/campanhas/leads/loja/${zeissConfig.storeId}/${campaignId}`;
    return await this.client.fetch<Record<string, unknown>[]>(zeissConfig.campaignsBaseUrl, path, { signal: abortSignal });
  }

  // LEAD-002
  async getRedeemedLeads(campaignId: string, abortSignal?: AbortSignal) {
    const path = `/prd/campanhas/leads/resgatado/loja/${zeissConfig.storeId}/${campaignId}`;
    return await this.client.fetch<Record<string, unknown>[]>(zeissConfig.campaignsBaseUrl, path, { signal: abortSignal });
  }

  // VCH-001
  async getVoucherDetail(campaignId: string, voucherCode: string, abortSignal?: AbortSignal) {
    const path = `/prd/campanhas/voucher/details/${campaignId}/${voucherCode}`;
    return await this.client.fetch<Record<string, unknown>[]>(zeissConfig.campaignsBaseUrl, path, { signal: abortSignal });
  }

  // VCH-002
  async generateVoucher(payload: Record<string, unknown>) {
    if (process.env.ALLOW_EXTERNAL_MUTATIONS !== 'true') {
      throw new Error('EXTERNAL MUTATIONS ARE DISABLED. Set ALLOW_EXTERNAL_MUTATIONS=true to execute.');
    }
    const path = `/vouchers/gerar`;
    return await this.client.fetch<Record<string, unknown>[]>(zeissConfig.campaignsBaseUrl, path, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  // VCH-003
  async activateVoucher(campaignId: string, voucherCode: string) {
    if (process.env.ALLOW_EXTERNAL_MUTATIONS !== 'true') {
      throw new Error('EXTERNAL MUTATIONS ARE DISABLED.');
    }
    const path = `/vouchers/ativar`;
    return await this.client.fetch<Record<string, unknown>[]>(zeissConfig.campaignsBaseUrl, path, {
      method: 'POST',
      body: JSON.stringify({
        campaignId, voucherCode, userId: zeissConfig.voucherUserId, loja: zeissConfig.storeId
      })
    });
  }
}
