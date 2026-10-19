// ============================================================
// Serving API Handlers — BD_API_ZEISS Platform
// ============================================================

import { IDatabaseExecutor } from '../config/db';
import { ApiError } from './types';
import { IStoreResolutionService } from '../core/StoreResolutionService';
import { AuditService } from './audit';
import { VouchersProvider } from '../providers/vouchers';

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
        d.situacao as detail_situacao, d.invoices as detail_invoices, d.updated_at as detail_updated_at
      FROM zeiss.orders o
      LEFT JOIN zeiss.order_details d ON d.order_id = o.id
      WHERE o.store_id = $1 AND o.order_number = $2
    `;

    const rows = await this.db.query(query, [storeId, orderNumber]);
    if (rows.length === 0) {
      throw new ApiError(404, 'NOT_FOUND', `Order '${orderNumber}' not found for store '${storeId}'`);
    }

    return rows[0];
  }

  // ------------------------------------------------------------
  // 2. TRACKING DOMAIN
  // ------------------------------------------------------------

  /**
   * GET /api/v1/stores/:store_id/tracking/:nf_number
   * Returns tracking status for an NF, verifying it belongs to the store.
   */
  async getTrackingByNf(storeId: string, nfNumber: string) {
    const query = `
      SELECT 
        t.id, t.order_id, o.order_number, t.nf_number, t.events, t.carrier, t.updated_at
      FROM zeiss.tracking_events t
      JOIN zeiss.orders o ON o.id = t.order_id
      WHERE o.store_id = $1 AND t.nf_number = $2
    `;

    const rows = await this.db.query(query, [storeId, nfNumber]);
    if (rows.length === 0) {
      throw new ApiError(404, 'NOT_FOUND', `Tracking for NF '${nfNumber}' not found for store '${storeId}'`);
    }

    return rows[0];
  }

  // ------------------------------------------------------------
  // 3. CAMPAIGNS & LEADS DOMAIN
  // ------------------------------------------------------------

  /**
   * GET /api/v1/stores/:store_id/campaigns
   * Returns active campaigns.
   */
  async listCampaigns(storeId: string) {
    const rows = await this.db.query(
      `SELECT 
         id, campaign_id, title, slogan, description, start_date, end_date, status, incentive_type, updated_at
       FROM zeiss.campaigns
       WHERE status = 'S' OR status = 'true' OR status = '1'
       ORDER BY start_date DESC NULLS LAST`
    );

    return {
      storeId,
      campaigns: rows
    };
  }

  /**
   * GET /api/v1/stores/:store_id/campaigns/:campaign_id/leads
   * Returns leads for a store and campaign (pseudonymized HMAC preserved).
   */
  async listLeads(storeId: string, campaignId: string, query: Record<string, string | undefined>) {
    const { page, limit, offset } = parsePagination(query);

    const countRows = await this.db.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM zeiss.leads WHERE store_id = $1 AND campaign_id = $2',
      [storeId, campaignId]
    );
    const total = parseInt(countRows[0]?.count || '0', 10);

    const rows = await this.db.query(
      `SELECT 
         id, campaign_id, voucher_code, status, email_hmac, updated_at
       FROM zeiss.leads
       WHERE store_id = $1 AND campaign_id = $2
       ORDER BY updated_at DESC
       LIMIT $3 OFFSET $4`,
      [storeId, campaignId, limit, offset]
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

  // ------------------------------------------------------------
  // 4. VOUCHERS MUTATION (IDEMPOTENT)
  // ------------------------------------------------------------

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

    // 1. Idempotency Check
    const check = await this.auditService.checkOrRegisterIdempotency(
      consumerId,
      'vouchers:activate',
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
      await this.auditService.finalizeOperation(check.operationId, 'completed', result);

      return {
        ...result,
        _replayed: false
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.auditService.finalizeOperation(check.operationId, 'failed', null, msg);
      throw new ApiError(500, 'INTERNAL_ERROR', `Voucher activation failed: ${msg}`);
    }
  }

  // ------------------------------------------------------------
  // 5. ADMINISTRATIVE HISTORICAL ACCESS (SEGREGATED)
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
