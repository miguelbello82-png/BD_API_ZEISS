import { ZeissApiClient } from '../config/client';
import { zeissConfig } from '../config/config';
import { StoreZeissContext } from '../contracts/store';

export class ProductsProvider {
  private client: ZeissApiClient;

  constructor(
    private storeContext?: StoreZeissContext,
    client?: ZeissApiClient
  ) {
    this.client = client || new ZeissApiClient();
  }

  // PRD-001
  async getProducts(abortSignal?: AbortSignal, contextOverride?: Partial<StoreZeissContext>) {
    const countryId = contextOverride?.countryId || this.storeContext?.countryId || zeissConfig.countryId;
    const cnpj = contextOverride?.cnpj || this.storeContext?.cnpj || zeissConfig.cnpj;
    const baseUrl = contextOverride?.ordersBaseUrl || this.storeContext?.ordersBaseUrl || zeissConfig.ordersBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/produtos/lista/${countryId}/${cnpj}`;
    const res = await this.client.fetch<Record<string, unknown>>(baseUrl, path, { signal: abortSignal, apiKey });
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
