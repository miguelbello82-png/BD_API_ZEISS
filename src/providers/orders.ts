import { ZeissApiClient } from '../config/client';
import { zeissConfig } from '../config/config';

export class OrdersProvider {
  private client: ZeissApiClient;

  constructor() {
    this.client = new ZeissApiClient();
  }

  // ORD-001
  async getOrders(startDate: string, endDate: string, status: string, abortSignal?: AbortSignal) {
    const path = `/prd/pedidos/data/${zeissConfig.cnpj}/${zeissConfig.countryId}/${startDate}/${endDate}/${status}`;
    const res = await this.client.fetch<Record<string, unknown>>(zeissConfig.ordersBaseUrl, path, { signal: abortSignal });
    if (!res || !Array.isArray(res.pedidos)) {
      throw new Error('ZEISS API Contract Error: Expected { pedidos: [] }');
    }
    return res.pedidos;
  }

  // ORD-002
  async getOrderDetail(orderNumber: string, abortSignal?: AbortSignal) {
    const path = `/prd/pedidos/detalhe`;
    return await this.client.fetch<Record<string, unknown>>(zeissConfig.ordersBaseUrl, path, {
      method: 'POST',
      body: JSON.stringify({
        idpais: zeissConfig.countryId,
        numpedido: orderNumber,
        codcli: zeissConfig.saowebCode
      }),
      signal: abortSignal
    });
  }

  // TRK-001
  async getTracking(numnf: string, abortSignal?: AbortSignal) {
    const path = `/prd/pedidos/tracking/drivin/${zeissConfig.countryId}/${zeissConfig.saowebCode}/${numnf}`;
    return await this.client.fetch<Record<string, unknown>[]>(zeissConfig.trackingBaseUrl, path, { signal: abortSignal });
  }
}
