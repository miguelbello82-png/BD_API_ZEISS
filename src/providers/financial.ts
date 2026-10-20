import { ZeissApiClient } from '../config/client';
import { zeissConfig } from '../config/config';
import { StoreZeissContext } from '../contracts/store';

export class FinancialProvider {
  private client: ZeissApiClient;

  constructor(
    private storeContext?: StoreZeissContext,
    client?: ZeissApiClient
  ) {
    this.client = client || new ZeissApiClient();
  }

  // FIN-001
  async getReceivables(
    periodStart: string,
    periodEnd: string,
    status: string,
    pedido: string,
    abortSignal?: AbortSignal,
    contextOverride?: Partial<StoreZeissContext>
  ) {
    const storeId = contextOverride?.zeissStoreCode || this.storeContext?.zeissStoreCode || zeissConfig.storeId;
    const countryId = contextOverride?.countryId || this.storeContext?.countryId || zeissConfig.countryId;
    const baseUrl = contextOverride?.financialBaseUrl || this.storeContext?.financialBaseUrl || zeissConfig.financialBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/financial/receivable/${storeId}/${periodStart}/${periodEnd}/${status}/${pedido}/${countryId}`;
    if (apiKey) {
      const res = await this.client.fetch<Record<string, unknown>>(baseUrl, path, { signal: abortSignal, apiKey });
      if (!Array.isArray(res)) {
        throw new Error('ZEISS API Contract Error: Expected an array for receivables');
      }
      return res;
    }
    const res = await this.client.fetch<Record<string, unknown>>(baseUrl, path, { signal: abortSignal });
    if (!Array.isArray(res)) {
      throw new Error('ZEISS API Contract Error: Expected an array for receivables');
    }
    return res;
  }

  // FIN-002
  async getBoleto(
    boletoId: string,
    dueDate: string,
    abortSignal?: AbortSignal,
    contextOverride?: Partial<StoreZeissContext>
  ) {
    const storeId = contextOverride?.zeissStoreCode || this.storeContext?.zeissStoreCode || zeissConfig.storeId;
    const finUserId = contextOverride?.finUserId || this.storeContext?.finUserId || zeissConfig.finUserId;
    const baseUrl = contextOverride?.financialBaseUrl || this.storeContext?.financialBaseUrl || zeissConfig.financialBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const path = `/prd/financial/receivable/boletourl/${boletoId}/${dueDate}/${storeId}/${finUserId}`;
    if (apiKey) {
      return await this.client.fetch<Record<string, unknown>>(baseUrl, path, { signal: abortSignal, apiKey });
    }
    return await this.client.fetch<Record<string, unknown>>(baseUrl, path, { signal: abortSignal });
  }

  // FIN-003
  async getDanfe(
    nfNumber: string,
    nfSeries: string = '1',
    contextOverride?: Partial<StoreZeissContext>
  ) {
    const storeId = contextOverride?.zeissStoreCode || this.storeContext?.zeissStoreCode || zeissConfig.storeId;
    const countryId = contextOverride?.countryId || this.storeContext?.countryId || zeissConfig.countryId;
    const baseUrl = contextOverride?.ordersBaseUrl || this.storeContext?.ordersBaseUrl || zeissConfig.ordersBaseUrl;
    const apiKey = contextOverride?.apiKey || this.storeContext?.apiKey;

    const cleanNf = nfNumber.replace(/^0+/, '');
    const cleanSeries = (nfSeries || '1').padStart(3, '0');
    const formattedNf = `${cleanNf}${cleanSeries}`.padStart(12, '0');

    const path = `/prd/pedidos/nf/${countryId}/${storeId}/${formattedNf}`;
    if (apiKey) {
      return await this.client.fetch<Record<string, unknown>>(baseUrl, path, { apiKey });
    }
    return await this.client.fetch<Record<string, unknown>>(baseUrl, path);
  }
}
