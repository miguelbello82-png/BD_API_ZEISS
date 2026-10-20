// ============================================================
// Serving API Handlers — BD_API_ZEISS Platform
// ============================================================

import { IDatabaseExecutor } from '../config/db';
import { ApiError, VoucherGenerateRequestPayload } from './types';
import { IStoreResolutionService } from '../core/StoreResolutionService';
import { AuditService } from './audit';
import { VouchersProvider } from '../providers/vouchers';
import { FinancialProvider } from '../providers/financial';

export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export function parsePagination(query: Record<string, string | undefined>): PaginationParams {
  const page = Math.max(parseInt(query.page || '1', 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit || '50', 10) || 50, 1), 200);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export class ApiHandlers {
  constructor(
    private db: IDatabaseExecutor,
    private storeResolutionService?: IStoreResolutionService,
    private auditService?: AuditService
  ) {}

  // ------------------------------------------------------------
  // 1. ORDERS DOMAIN
  // ------------------------------------------------------------

  /**
   * GET /api/v1/stores/:store_id/orders
   * Filters strictly by store_id. Unassigned historical rows (store_id IS NULL) are NEVER returned.
   */
  async listOrders(storeId: string, query: Record<string, string | undefined>) {
    const { page, limit, offset } = parsePagination(query);
    const conditions: string[] = ['store_id = $1'];
    const params: unknown[] = [storeId];
    let paramIndex = 2;

    if (query.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(query.status);
      paramIndex++;
    }

    if (query.os_number) {
      conditions.push(`os_number = $${paramIndex}`);
      params.push(query.os_number);
      paramIndex++;
    }

    if (query.start_date) {
      conditions.push(`entry_date >= $${paramIndex}`);
      params.push(query.start_date);
      paramIndex++;
    }

    if (query.end_date) {
      conditions.push(`entry_date <= $${paramIndex}`);
      params.push(query.end_date);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    // Total count query
    const countRows = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM zeiss.orders WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRows[0]?.count || '0', 10);

    // Data query
    const dataRows = await this.db.query(
      `SELECT 
         id, order_number, os_number, status, codsit, entry_date, expected_date, created_at, updated_at
       FROM zeiss.orders
       WHERE ${whereClause}
       ORDER BY entry_date DESC NULLS LAST, created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return {
      orders: dataRows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * GET /api/v1/stores/:store_id/orders/:order_number
   * Returns order and aggregated detail for the specified store.
   */
  async getOrderDetail(storeId: string, orderNumber: string) {
    const query = `
      SELECT 
        o.id, o.order_number, o.os_number, o.status, o.codsit, o.entry_date, o.expected_date,
        o.created_at, o.updated_at,
        d.raw_status as detail_status, d.raw_situacao as detail_situacao, d.updated_at as detail_updated_at
      FROM zeiss.orders o
      LEFT JOIN zeiss.order_details d ON d.order_id = o.id
      WHERE o.store_id = $1 AND o.order_number = $2
    `;

    const rows = await this.db.query(query, [storeId, orderNumber]);
    if (rows.length === 0) {
      throw new ApiError(404, 'NOT_FOUND', `Order '${orderNumber}' not found for store '${storeId}'`);
    }

    const order = rows[0] as Record<string, unknown>;

    // Fetch linked fiscal documents for this order
    const fiscalDocs = await this.db.query(
      `SELECT id, nf_number, nf_series, created_at
       FROM zeiss.fiscal_documents
       WHERE order_id = $1
       ORDER BY created_at DESC`,
      [order.id]
    );

    return {
      ...order,
      fiscal_documents: fiscalDocs
    };
  }

  // ------------------------------------------------------------
  // 2. TRACKING DOMAIN
  // ------------------------------------------------------------

  /**
   * GET /api/v1/stores/:store_id/tracking/:nf_number
   * Returns tracking events for an NF, verifying it belongs to the store.
   */
  async getTrackingByNf(storeId: string, nfNumber: string) {
    const query = `
      SELECT 
        t.id, t.order_id, o.order_number, t.nf_number, t.status, t.event_date,
        t.status_aprovada, t.status_inicio, t.status_chegada, t.status_entrega, t.data_entrega,
        t.created_at
      FROM zeiss.tracking_events t
      JOIN zeiss.orders o ON o.id = t.order_id
      WHERE o.store_id = $1 AND t.nf_number = $2
      ORDER BY t.event_date DESC NULLS LAST, t.created_at DESC
    `;

    const rows = await this.db.query(query, [storeId, nfNumber]);
    if (rows.length === 0) {
      throw new ApiError(404, 'NOT_FOUND', `Tracking for NF '${nfNumber}' not found for store '${storeId}'`);
    }

    return {
      storeId,
      nfNumber,
      orderNumber: (rows[0] as any).order_number,
      events: rows
    };
  }

  /**
   * GET /api/v1/stores/:store_id/orders/:order_number/tracking
   * Returns tracking events for a specific order.
   */
  async getTrackingByOrder(storeId: string, orderNumber: string) {
    const query = `
      SELECT 
        t.id, t.order_id, o.order_number, t.nf_number, t.status, t.event_date,
        t.status_aprovada, t.status_inicio, t.status_chegada, t.status_entrega, t.data_entrega,
        t.created_at
      FROM zeiss.tracking_events t
      JOIN zeiss.orders o ON o.id = t.order_id
      WHERE o.store_id = $1 AND o.order_number = $2
      ORDER BY t.event_date DESC NULLS LAST, t.created_at DESC
    `;

    const rows = await this.db.query(query, [storeId, orderNumber]);
    if (rows.length === 0) {
      // Check if order itself exists
      const orderExists = await this.db.query(
        'SELECT id FROM zeiss.orders WHERE store_id = $1 AND order_number = $2',
        [storeId, orderNumber]
      );
      if (orderExists.length === 0) {
        throw new ApiError(404, 'NOT_FOUND', `Order '${orderNumber}' not found for store '${storeId}'`);
      }
      return {
        storeId,
        orderNumber,
        events: []
      };
    }

    return {
      storeId,
      orderNumber,
      events: rows
    };
  }

  // ------------------------------------------------------------
  // 3. CAMPAIGNS & LEADS DOMAIN
  // ------------------------------------------------------------

  /**
   * GET /api/v1/stores/:store_id/campaigns
   * Returns active campaigns with store-specific adhesion details.
   */
  async listCampaigns(storeId: string) {
    const rows = await this.db.query(
      `SELECT 
         c.id,
         c.campaign_id,
         c.title,
         c.slogan,
         c.description,
         c.start_date,
         c.end_date,
         c.status as global_status,
         sc.status as store_status,
         COALESCE(sc.aceite, c.aceite) as aceite,
         COALESCE(sc.incentive_type, c.incentive_type) as incentive_type,
         c.updated_at
       FROM zeiss.campaigns c
       LEFT JOIN zeiss.store_campaigns sc ON sc.campaign_id = c.campaign_id AND sc.store_id = $1
       WHERE c.status = 'S' OR c.status = 'true' OR c.status = '1'
       ORDER BY c.start_date DESC NULLS LAST`,
      [storeId]
    );

    return {
      storeId,
      campaigns: rows
    };
  }

  /**
   * GET /api/v1/stores/:store_id/campaigns/:campaign_id
   * Returns single campaign detail with store adhesion status.
   */
  async getCampaignDetail(storeId: string, campaignId: string) {
    const rows = await this.db.query(
      `SELECT 
         c.id,
         c.campaign_id,
         c.title,
         c.slogan,
         c.description,
         c.start_date,
         c.end_date,
         c.status as global_status,
         sc.status as store_status,
         COALESCE(sc.aceite, c.aceite) as aceite,
         COALESCE(sc.incentive_type, c.incentive_type) as incentive_type,
         c.updated_at
       FROM zeiss.campaigns c
       LEFT JOIN zeiss.store_campaigns sc ON sc.campaign_id = c.campaign_id AND sc.store_id = $1
       WHERE c.campaign_id = $2`,
      [storeId, campaignId]
    );

    if (rows.length === 0) {
      throw new ApiError(404, 'NOT_FOUND', `Campaign '${campaignId}' not found`);
    }

    return rows[0];
  }

  /**
   * GET /api/v1/stores/:store_id/campaigns/:campaign_id/leads
   * Returns leads for a store and campaign (pseudonymized HMAC preserved).
   */
  async listLeads(storeId: string, campaignId: string, query: Record<string, string | undefined>) {
    const { page, limit, offset } = parsePagination(query);
    const conditions: string[] = ['store_id = $1', 'campaign_id = $2'];
    const params: unknown[] = [storeId, campaignId];
    let paramIndex = 3;

    if (query.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(query.status);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    const countRows = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM zeiss.leads WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRows[0]?.count || '0', 10);

    const rows = await this.db.query(
      `SELECT 
         id, campaign_id, voucher_code, status, email_hmac, updated_at
       FROM zeiss.leads
       WHERE ${whereClause}
       ORDER BY updated_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return {
      campaignId,
      storeId,
      leads: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * GET /api/v1/stores/:store_id/leads/:voucher_code
   * Retrieves single lead by voucher code for the store.
   */
  async getLeadByVoucher(storeId: string, voucherCode: string) {
    const rows = await this.db.query(
      `SELECT 
         id, campaign_id, voucher_code, status, email_hmac, created_at, updated_at
       FROM zeiss.leads
       WHERE store_id = $1 AND voucher_code = $2`,
      [storeId, voucherCode]
    );

    if (rows.length === 0) {
      throw new ApiError(404, 'NOT_FOUND', `Lead with voucher code '${voucherCode}' not found for store '${storeId}'`);
    }

    return rows[0];
  }

  // ------------------------------------------------------------
  // 4. VOUCHERS DOMAIN
  // ------------------------------------------------------------

  /**
   * GET /api/v1/stores/:store_id/vouchers/:voucher_code
   * Retrieves voucher details on-demand.
   */
  async getVoucherDetail(storeId: string, voucherCode: string, query?: Record<string, string | undefined>) {
    // 1. Check local repository first
    const localRows = await this.db.query(
      `SELECT id, voucher_code, campaign_id, lead_id, status, created_at, updated_at
       FROM zeiss.vouchers
       WHERE store_id = $1 AND voucher_code = $2`,
      [storeId, voucherCode]
    );

    if (localRows.length > 0) {
      return localRows[0];
    }

    // 2. If campaignId is supplied or found via leads, query live ZEISS VCH-001
    const campaignId = query?.campaignId || (await this.findCampaignIdForVoucher(storeId, voucherCode));
    if (campaignId && this.storeResolutionService) {
      try {
        const context = await this.storeResolutionService.resolveStore(storeId);
        const vouchersProvider = new VouchersProvider(context);
        const liveDetail = await vouchersProvider.getVoucherDetail(campaignId, voucherCode);
        return {
          storeId,
          voucherCode,
          campaignId,
          details: liveDetail,
          source: 'ZEISS_LIVE'
        };
      } catch (err) {
        // Fallback to 404
      }
    }

    throw new ApiError(404, 'NOT_FOUND', `Voucher '${voucherCode}' not found for store '${storeId}'`);
  }

  private async findCampaignIdForVoucher(storeId: string, voucherCode: string): Promise<string | undefined> {
    const rows = await this.db.query<{ campaign_id: string }>(
      'SELECT campaign_id FROM zeiss.leads WHERE store_id = $1 AND voucher_code = $2 LIMIT 1',
      [storeId, voucherCode]
    );
    return rows[0]?.campaign_id;
  }

  /**
   * POST /api/v1/stores/:store_id/vouchers/activate
   * Activates a voucher for a customer. Enforces Idempotency-Key.
   */
  async activateVoucher(
    storeId: string,
    consumerId: string,
    idempotencyKey: string | undefined,
    body: { campaignId: string; voucherCode: string; pin?: string }
  ) {
    if (!body || !body.campaignId || !body.voucherCode) {
      throw new ApiError(400, 'BAD_REQUEST', 'campaignId and voucherCode are required');
    }

    if (!idempotencyKey) {
      throw new ApiError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required for voucher activation');
    }

    if (!this.auditService) {
      throw new ApiError(500, 'INTERNAL_ERROR', 'Audit service not configured');
    }

    // Check external mutation safety switch
    if (process.env.ALLOW_EXTERNAL_MUTATIONS !== 'true') {
      throw new ApiError(
        403,
        'MUTATION_DISABLED',
        'External mutations are disabled in the current environment (ALLOW_EXTERNAL_MUTATIONS=false)'
      );
    }

    // 1. Idempotency Check
    const check = await this.auditService.checkOrRegisterIdempotency(
      consumerId,
      'voucher.activate',
      storeId,
      idempotencyKey,
      body
    );

    if (check.isDuplicate && check.previousResponse) {
      return {
        ...(check.previousResponse as object),
        _replayed: true
      };
    }

    if (!this.storeResolutionService) {
      throw new ApiError(500, 'INTERNAL_ERROR', 'Store resolution service not configured');
    }

    // 2. Resolve Store Context and Invoke Provider
    try {
      const context = await this.storeResolutionService.resolveStore(storeId);
      const vouchersProvider = new VouchersProvider(context);

      const result = await vouchersProvider.activateVoucher(
        body.campaignId,
        body.voucherCode
      );

      // 3. Finalize audit operation
      await this.auditService.finalizeOperation(check.operationId, 'SUCCEEDED', result);

      return {
        ...result,
        _replayed: false
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.auditService.finalizeOperation(check.operationId, 'FAILED_FINAL', null, msg);
      throw new ApiError(500, 'INTERNAL_ERROR', `Voucher activation failed: ${msg}`);
    }
  }

  /**
   * POST /api/v1/stores/:store_id/vouchers/generate
   * Generates a new voucher in ZEISS (VCH-002). Enforces Idempotency-Key.
   */
  async generateVoucher(
    storeId: string,
    consumerId: string,
    idempotencyKey: string | undefined,
    body: VoucherGenerateRequestPayload
  ) {
    if (!body || !body.campaignId || !body.name || !body.email) {
      throw new ApiError(400, 'BAD_REQUEST', 'campaignId, name and email are required');
    }

    if (!idempotencyKey) {
      throw new ApiError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required for voucher generation');
    }

    if (!this.auditService) {
      throw new ApiError(500, 'INTERNAL_ERROR', 'Audit service not configured');
    }

    // Check external mutation safety switch
    if (process.env.ALLOW_EXTERNAL_MUTATIONS !== 'true') {
      throw new ApiError(
        403,
        'MUTATION_DISABLED',
        'External mutations are disabled in the current environment (ALLOW_EXTERNAL_MUTATIONS=false)'
      );
    }

    // 1. Idempotency Check
    const check = await this.auditService.checkOrRegisterIdempotency(
      consumerId,
      'voucher.generate',
      storeId,
      idempotencyKey,
      body
    );

    if (check.isDuplicate && check.previousResponse) {
      return {
        ...(check.previousResponse as object),
        _replayed: true
      };
    }

    if (!this.storeResolutionService) {
      throw new ApiError(500, 'INTERNAL_ERROR', 'Store resolution service not configured');
    }

    // 2. Resolve Store Context and Invoke Provider
    try {
      const context = await this.storeResolutionService.resolveStore(storeId);
      const vouchersProvider = new VouchersProvider(context);

      const zeissPayload: Record<string, unknown> = {
        idcampaign: body.campaignId,
        source: body.source ?? 12,
        useremail: body.email,
        name: body.name,
        phone: body.phone ?? '',
        cpf: body.cpf ?? '',
        idstore: context.zeissStoreCode,
        zipcode: body.zipcode ?? '',
        city: body.city ?? '',
        state: body.state ?? '',
        sendmail: body.sendmail ?? 'S',
        termssn: body.termssn ?? 'S',
        comunicadossn: body.comunicadossn ?? 'N'
      };

      const result = await vouchersProvider.generateVoucher(zeissPayload);

      // 3. Finalize audit operation
      await this.auditService.finalizeOperation(check.operationId, 'SUCCEEDED', result);

      return {
        ...result,
        _replayed: false
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.auditService.finalizeOperation(check.operationId, 'FAILED_FINAL', null, msg);
      throw new ApiError(500, 'INTERNAL_ERROR', `Voucher generation failed: ${msg}`);
    }
  }

  // ------------------------------------------------------------
  // 5. PRODUCTS & SERVICES DOMAIN
  // ------------------------------------------------------------

  /**
   * GET /api/v1/products
   * Returns paginated master product catalog.
   */
  async listProducts(query: Record<string, string | undefined>) {
    const { page, limit, offset } = parsePagination(query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (query.category) {
      conditions.push(`category = $${paramIndex}`);
      params.push(query.category);
      paramIndex++;
    }

    if (query.active !== undefined) {
      const isActive = query.active === 'true' || query.active === '1';
      conditions.push(`active = $${paramIndex}`);
      params.push(isActive);
      paramIndex++;
    }

    if (query.search) {
      conditions.push(`(name ILIKE $${paramIndex} OR zeiss_product_code ILIKE $${paramIndex})`);
      params.push(`%${query.search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRows = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM zeiss.products ${whereClause}`,
      params
    );
    const total = parseInt(countRows[0]?.count || '0', 10);

    const rows = await this.db.query(
      `SELECT 
         id, zeiss_product_code, name, category, design, material, refractive_index, description, active, updated_at
       FROM zeiss.products
       ${whereClause}
       ORDER BY name ASC NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return {
      products: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * GET /api/v1/products/:product_code
   * Retrieves single product by ZEISS product code.
   */
  async getProductDetail(productCode: string) {
    const rows = await this.db.query(
      `SELECT 
         id, zeiss_product_code, name, category, design, material, refractive_index, description, active, updated_at
       FROM zeiss.products
       WHERE zeiss_product_code = $1`,
      [productCode]
    );

    if (rows.length === 0) {
      throw new ApiError(404, 'NOT_FOUND', `Product '${productCode}' not found`);
    }

    return rows[0];
  }

  /**
   * GET /api/v1/products/:product_code/services
   * Returns services associated with a master product.
   */
  async listProductServices(productCode: string) {
    const productRows = await this.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM zeiss.products WHERE zeiss_product_code = $1`,
      [productCode]
    );

    if (productRows.length === 0) {
      throw new ApiError(404, 'NOT_FOUND', `Product '${productCode}' not found`);
    }

    const services = await this.db.query(
      `SELECT 
         id, service_code, service_name, service_type, description, created_at
       FROM zeiss.product_services
       WHERE product_id = $1
       ORDER BY service_code ASC`,
      [productRows[0].id]
    );

    return {
      productCode,
      productName: productRows[0].name,
      services
    };
  }

  // ------------------------------------------------------------
  // 6. FINANCIAL & DOCUMENTS DOMAIN
  // ------------------------------------------------------------

  /**
   * GET /api/v1/stores/:store_id/financial/receivables
   * Returns list of receivables/boletos for the store.
   */
  async listReceivables(storeId: string, query: Record<string, string | undefined>) {
    const { page, limit, offset } = parsePagination(query);
    const conditions: string[] = ['store_id = $1'];
    const params: unknown[] = [storeId];
    let paramIndex = 2;

    if (query.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(query.status);
      paramIndex++;
    }

    if (query.boleto_number) {
      conditions.push(`boleto_number = $${paramIndex}`);
      params.push(query.boleto_number);
      paramIndex++;
    }

    if (query.start_date) {
      conditions.push(`emission_date >= $${paramIndex}`);
      params.push(query.start_date);
      paramIndex++;
    }

    if (query.end_date) {
      conditions.push(`due_date <= $${paramIndex}`);
      params.push(query.end_date);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    const countRows = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM zeiss.receivables WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRows[0]?.count || '0', 10);

    const rows = await this.db.query(
      `SELECT 
         id, boleto_number, fiscal_reference, emission_date, due_date, amount, status, order_id, updated_at
       FROM zeiss.receivables
       WHERE ${whereClause}
       ORDER BY due_date DESC NULLS LAST, emission_date DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return {
      storeId,
      receivables: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * GET /api/v1/stores/:store_id/financial/boletos/:boleto_id
   * On-demand consultation of boleto URL (FIN-002).
   */
  async getBoleto(storeId: string, boletoId: string, query: Record<string, string | undefined>) {
    let dueDate = query.dueDate;

    // If dueDate not provided in query, look up in receivables
    if (!dueDate) {
      const rec = await this.db.query<{ due_date: string }>(
        'SELECT due_date FROM zeiss.receivables WHERE store_id = $1 AND boleto_number = $2',
        [storeId, boletoId]
      );
      if (rec.length > 0 && rec[0].due_date) {
        dueDate = new Date(rec[0].due_date).toISOString().slice(0, 10);
      }
    }

    if (!dueDate) {
      throw new ApiError(400, 'BAD_REQUEST', 'dueDate query parameter is required (YYYY-MM-DD)');
    }

    if (!this.storeResolutionService) {
      throw new ApiError(500, 'INTERNAL_ERROR', 'Store resolution service not configured');
    }

    const context = await this.storeResolutionService.resolveStore(storeId);
    const financialProvider = new FinancialProvider(context);

    try {
      const result = await financialProvider.getBoleto(boletoId, dueDate);
      return {
        storeId,
        boletoId,
        dueDate,
        data: result
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError(500, 'INTERNAL_ERROR', `Boleto fetch failed: ${msg}`);
    }
  }

  /**
   * GET /api/v1/stores/:store_id/financial/danfe/:nf_number
   * On-demand consultation of DANFE / fiscal document (FIN-003).
   */
  async getDanfe(storeId: string, nfNumber: string, query: Record<string, string | undefined>) {
    const series = query.series || '1';

    if (!this.storeResolutionService) {
      throw new ApiError(500, 'INTERNAL_ERROR', 'Store resolution service not configured');
    }

    const context = await this.storeResolutionService.resolveStore(storeId);
    const financialProvider = new FinancialProvider(context);

    try {
      const result = await financialProvider.getDanfe(nfNumber, series);
      return {
        storeId,
        nfNumber,
        series,
        data: result
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError(500, 'INTERNAL_ERROR', `DANFE fetch failed: ${msg}`);
    }
  }

  /**
   * GET /api/v1/stores/:store_id/orders/:order_number/fiscal-documents
   * Lists synchronized fiscal documents for a store order.
   */
  async listFiscalDocuments(storeId: string, orderNumber: string) {
    const query = `
      SELECT 
        fd.id, fd.order_id, fd.nf_number, fd.nf_series, fd.created_at, o.order_number
      FROM zeiss.fiscal_documents fd
      JOIN zeiss.orders o ON o.id = fd.order_id
      WHERE o.store_id = $1 AND o.order_number = $2
      ORDER BY fd.created_at DESC
    `;

    const rows = await this.db.query(query, [storeId, orderNumber]);
    return {
      storeId,
      orderNumber,
      documents: rows
    };
  }

  // ------------------------------------------------------------
  // 7. ADMINISTRATIVE HISTORICAL ACCESS (SEGREGATED)
  // ------------------------------------------------------------

  /**
   * GET /api/v1/admin/unassigned-orders
   * Requires scope 'admin:historical:read'.
   * Allows inspecting historical orders where store_id IS NULL.
   * STRICTLY SEGREGATED from store endpoints.
   */
  async listUnassignedOrders(query: Record<string, string | undefined>) {
    const { page, limit, offset } = parsePagination(query);

    const countRows = await this.db.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM zeiss.orders WHERE store_id IS NULL'
    );
    const total = parseInt(countRows[0]?.count || '0', 10);

    const rows = await this.db.query(
      `SELECT 
         id, order_number, os_number, status, codsit, entry_date, expected_date, created_at, updated_at
       FROM zeiss.orders
       WHERE store_id IS NULL
       ORDER BY entry_date DESC NULLS LAST, created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return {
      message: 'Unassigned historical orders (pending reconciliation)',
      orders: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }
}
