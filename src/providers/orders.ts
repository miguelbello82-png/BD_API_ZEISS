import { ZeissApiClient } from '../config/client';
import { zeissConfig } from '../config/config';
import { StoreZeissContext } from '../contracts/store';

export class OrdersProvider {
  private client: ZeissApiClient;

  constructor(
    private storeContext?: StoreZeissContext,
    client?: ZeissApiClient
  ) {
    this.client = client || new ZeissApiClient();
  }

  // ORD-001
  async getOrders(
    startDate: string,
    endDate: string,
    status: string,
    abortSignal?: AbortSignal,
    contextOverride?: Partial<StoreZeissContext>
  ) {
    const cnpj = contextOverride?.cnpj || this.storeContext?.cnpj || zeissConfig.cnpj;
    const countryId = contextOverride?.countryId || this.storeContext?.countryId || zeissConfig.countryId;
    const baseUrl = contextOverride?.ordersBaseUrl || this.storeContext?.ordersBaseUrl || zeissConfig.ordersBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/pedidos/data/${cnpj}/${countryId}/${startDate}/${endDate}/${status}`;
    const res = await this.client.fetch<Record<string, unknown>>(baseUrl, path, { signal: abortSignal, apiKey });
    if (!res || !Array.isArray(res.pedidos)) {
      throw new Error('ZEISS API Contract Error: Expected { pedidos: [] }');
    }
    return res.pedidos;
  }

  // ORD-002
  async getOrderDetail(
    orderNumber: string,
    abortSignal?: AbortSignal,
    contextOverride?: Partial<StoreZeissContext>
  ) {
    const countryId = contextOverride?.countryId || this.storeContext?.countryId || zeissConfig.countryId;
    const saowebCode = contextOverride?.saowebCode || this.storeContext?.saowebCode || zeissConfig.saowebCode;
    const baseUrl = contextOverride?.ordersBaseUrl || this.storeContext?.ordersBaseUrl || zeissConfig.ordersBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/pedidos/detalhe`;
    return await this.client.fetch<Record<string, unknown>>(baseUrl, path, {
      method: 'POST',
      body: JSON.stringify({
        idpais: countryId,
        numpedido: orderNumber,
        codcli: saowebCode
      }),
      signal: abortSignal,
      apiKey
    });
  }

  // TRK-001
  async getTracking(
    numnf: string,
    abortSignal?: AbortSignal,
    contextOverride?: Partial<StoreZeissContext>
  ) {
    const countryId = contextOverride?.countryId || this.storeContext?.countryId || zeissConfig.countryId;
    const saowebCode = contextOverride?.saowebCode || this.storeContext?.saowebCode || zeissConfig.saowebCode;
    const baseUrl = contextOverride?.trackingBaseUrl || this.storeContext?.trackingBaseUrl || zeissConfig.trackingBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/pedidos/tracking/drivin/${countryId}/${saowebCode}/${numnf}`;
    return await this.client.fetch<Record<string, unknown>[]>(baseUrl, path, { signal: abortSignal, apiKey });
  }
}
