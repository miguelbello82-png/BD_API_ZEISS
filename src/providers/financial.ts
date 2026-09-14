import { ZeissApiClient } from '../config/client';
import { zeissConfig } from '../config/config';

export class FinancialProvider {
  private client: ZeissApiClient;

  constructor() {
    this.client = new ZeissApiClient();
  }

  // FIN-001
  async getReceivables(periodStart: string, periodEnd: string, status: string, pedido: string, abortSignal?: AbortSignal) {
    const path = `/prd/financial/receivable/${zeissConfig.storeId}/${periodStart}/${periodEnd}/${status}/${pedido}/${zeissConfig.countryId}`;
    const res = await this.client.fetch<Record<string, unknown>>(zeissConfig.financialBaseUrl, path, { signal: abortSignal });
    if (!Array.isArray(res)) {
      throw new Error('ZEISS API Contract Error: Expected an array for receivables');
    }
    return res;
  }

  // FIN-002
  async getBoleto(boletoId: string, dueDate: string, abortSignal?: AbortSignal) {
    const path = `/prd/financial/receivable/boletourl/${boletoId}/${dueDate}/${zeissConfig.storeId}/${zeissConfig.finUserId}`;
    return await this.client.fetch<Record<string, unknown>[]>(zeissConfig.financialBaseUrl, path, { signal: abortSignal });
  }

  // FIN-003
  async getDanfe(nfNumber: string, nfSeries: string) {
    const formattedNf = `${nfNumber}${nfSeries}`.padStart(12, '0');
    const path = `/prd/pedidos/nf/${zeissConfig.countryId}/${zeissConfig.storeId}/${formattedNf}`;
    return await this.client.fetch<Record<string, unknown>>(zeissConfig.ordersBaseUrl, path);
  }
}
