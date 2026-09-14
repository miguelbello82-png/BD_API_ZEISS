import { ZeissApiClient } from '../config/client';
import { zeissConfig } from '../config/config';

export class ProductsProvider {
  private client: ZeissApiClient;

  constructor() {
    this.client = new ZeissApiClient();
  }

  // PRD-001
  async getProducts(abortSignal?: AbortSignal) {
    const path = `/prd/produtos/lista/${zeissConfig.countryId}/${zeissConfig.cnpj}`;
    const res = await this.client.fetch<Record<string, unknown>>(zeissConfig.ordersBaseUrl, path, { signal: abortSignal });
    if (!res || typeof res !== 'object') {
      throw new Error('ZEISS API Contract Error: Expected object response');
    }
    const saoObj = res['sao'] as Record<string, unknown> | undefined;
    if (!saoObj || !Array.isArray(saoObj.produtos)) {
      throw new Error('ZEISS API Contract Error: Expected { sao: { produtos: [] } }');
    }
    return saoObj.produtos;
  }
}
