// ============================================================
// Provider Contracts — BD_API_ZEISS Platform
// ============================================================
// These interfaces formalize the ZEISS API providers for
// dependency injection. The concrete implementations already
// exist in src/providers/ but the engine depends on these
// abstractions, not on concrete classes.
// ============================================================

/**
 * PRD-001: Products provider.
 * Returns the full product catalog for the configured unit.
 */
export interface IProductsProvider {
  getProducts(abortSignal?: AbortSignal): Promise<Record<string, unknown>[]>;
}

export interface ICampaignsProvider {
  getCampaigns(abortSignal?: AbortSignal): Promise<Record<string, unknown>[]>;
}

export interface ILeadsProvider {
  getLeads(campaignId: string, abortSignal?: AbortSignal): Promise<Record<string, unknown>[]>;
  getRedeemedLeads(campaignId: string, abortSignal?: AbortSignal): Promise<Record<string, unknown>[]>;
}

export interface IOrdersListProvider {
  getOrders(startDate: string, endDate: string, status: string, abortSignal?: AbortSignal): Promise<Record<string, unknown>[]>;
}

export interface IOrderDetailProvider {
  getOrderDetail(orderNumber: string, abortSignal?: AbortSignal): Promise<Record<string, unknown>>;
}

export interface ITrackingProvider {
  getTracking(nfNumber: string, abortSignal?: AbortSignal): Promise<Record<string, unknown>[]>;
}

export interface IReceivablesProvider {
  getReceivables(periodStart: string, periodEnd: string, status: string, pedido: string, abortSignal?: AbortSignal): Promise<Record<string, unknown>[]>;
}

/**
 * VCH-001: Voucher detail provider (ON_DEMAND only).
 * Requires campaignId and voucherCode.
 */
export interface IVoucherDetailProvider {
  getVoucherDetail(campaignId: string, voucherCode: string): Promise<Record<string, unknown>>;
}

/**
 * FIN-002: Boleto provider (ON_DEMAND only).
 */
export interface IBoletoProvider {
  getBoleto(boletoId: string, dueDate: string): Promise<Record<string, unknown>>;
}

/**
 * FIN-003: NF/DANFE provider (ON_DEMAND only).
 */
export interface INfeProvider {
  getDanfe(nfNumber: string, nfSeries: string): Promise<Record<string, unknown>>;
}
