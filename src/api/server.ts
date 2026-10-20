// ============================================================
// Serving API Server & Router — BD_API_ZEISS Platform
// ============================================================

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });

import * as http from 'http';
import { URL } from 'url';
import { IDatabaseExecutor, createPgPool, PgDatabaseExecutor } from '../config/db';
import { ConsumerAuthService } from './auth';
import { AuditService } from './audit';
import { ApiHandlers } from './handlers';
import { ApiError, StandardApiResponse, VoucherGenerateRequestPayload } from './types';
import { IStoreResolutionService } from '../core/StoreResolutionService';
import { ILogger, ConsoleLogger } from '../observability/Logger';

import { PgStoreResolutionService } from '../core/StoreResolutionService';

export interface ServingApiOptions {
  port?: number;
  db: IDatabaseExecutor;
  storeResolutionService?: IStoreResolutionService;
  logger?: ILogger;
}

export class ServingApiServer {
  private server?: http.Server;
  private authService: ConsumerAuthService;
  private auditService: AuditService;
  private handlers: ApiHandlers;
  private logger: ILogger;

  constructor(private options: ServingApiOptions) {
    this.logger = options.logger || new ConsoleLogger();
    this.authService = new ConsumerAuthService(options.db);
    this.auditService = new AuditService(options.db);
    const storeResolver = options.storeResolutionService || new PgStoreResolutionService(options.db);
    this.handlers = new ApiHandlers(options.db, storeResolver, this.auditService);
  }

  getHttpServer(): http.Server {
    if (!this.server) {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.timeout = 30000; // 30s connection timeout
      this.server.keepAliveTimeout = 65000; // 65s keepalive to prevent 502s behind reverse proxies
      this.server.headersTimeout = 66000; // headers timeout must be greater than keepAliveTimeout
    }
    return this.server;
  }

  async listen(port?: number): Promise<number> {
    const srv = this.getHttpServer();
    const effectivePort = port ?? this.options.port ?? 3000;
    return new Promise((resolve, reject) => {
      srv.listen(effectivePort, () => {
        const addr = srv.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : effectivePort;
        this.logger.info('ServingApi', `Serving API listening on port ${actualPort}`);
        resolve(actualPort);
      });
      srv.on('error', reject);
    });
  }

  async close(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startTime = Date.now();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-API-Key, X-Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;
      const queryParams: Record<string, string | undefined> = {};
      parsedUrl.searchParams.forEach((val, key) => {
        queryParams[key] = val;
      });

      // --------------------------------------------------------
      // Route 0: Public Health Check
      // --------------------------------------------------------
      if (req.method === 'GET' && pathname === '/api/v1/health') {
        this.sendJson(res, 200, {
          success: true,
          data: { status: 'ok', timestamp: new Date().toISOString() }
        });
        return;
      }

      // Authentication Middleware (All endpoints below require authenticated consumer)
      const authHeader = (req.headers['authorization'] || req.headers['x-api-key']) as string | undefined;
      const consumer = await this.authService.authenticate(authHeader);

      let responseData: unknown = null;
      let targetStoreId: string | undefined;

      // --------------------------------------------------------
      // DOMAIN 1: ORDERS
      // --------------------------------------------------------

      // GET /api/v1/stores/:store_id/orders
      const ordersListMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/orders\/?$/);
      if (req.method === 'GET' && ordersListMatch) {
        targetStoreId = ordersListMatch[1];
        this.authService.authorize(consumer, 'orders:read', targetStoreId);
        responseData = await this.handlers.listOrders(targetStoreId, queryParams);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // GET /api/v1/stores/:store_id/orders/:order_number/tracking
      const orderTrackingMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/orders\/([^/]+)\/tracking\/?$/);
      if (req.method === 'GET' && orderTrackingMatch) {
        targetStoreId = orderTrackingMatch[1];
        const orderNumber = decodeURIComponent(orderTrackingMatch[2]);
        this.authService.authorize(consumer, 'tracking:read', targetStoreId);
        responseData = await this.handlers.getTrackingByOrder(targetStoreId, orderNumber);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // GET /api/v1/stores/:store_id/orders/:order_number/fiscal-documents
      const orderFiscalMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/orders\/([^/]+)\/fiscal-documents\/?$/);
      if (req.method === 'GET' && orderFiscalMatch) {
        targetStoreId = orderFiscalMatch[1];
        const orderNumber = decodeURIComponent(orderFiscalMatch[2]);
        this.authService.authorize(consumer, 'financial:read', targetStoreId);
        responseData = await this.handlers.listFiscalDocuments(targetStoreId, orderNumber);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // GET /api/v1/stores/:store_id/orders/:order_number
      const orderDetailMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/orders\/([^/]+)\/?$/);
      if (req.method === 'GET' && orderDetailMatch) {
        targetStoreId = orderDetailMatch[1];
        const orderNumber = decodeURIComponent(orderDetailMatch[2]);
        this.authService.authorize(consumer, 'orders:read', targetStoreId);
        responseData = await this.handlers.getOrderDetail(targetStoreId, orderNumber);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // --------------------------------------------------------
      // DOMAIN 2: TRACKING
      // --------------------------------------------------------

      // GET /api/v1/stores/:store_id/tracking/:nf_number
      const trackingMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/tracking\/([^/]+)\/?$/);
      if (req.method === 'GET' && trackingMatch) {
        targetStoreId = trackingMatch[1];
        const nfNumber = decodeURIComponent(trackingMatch[2]);
        this.authService.authorize(consumer, 'tracking:read', targetStoreId);
        responseData = await this.handlers.getTrackingByNf(targetStoreId, nfNumber);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // --------------------------------------------------------
      // DOMAIN 3: CAMPAIGNS
      // --------------------------------------------------------

      // GET /api/v1/stores/:store_id/campaigns/:campaign_id/leads
      const leadsMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/campaigns\/([^/]+)\/leads\/?$/);
      if (req.method === 'GET' && leadsMatch) {
        targetStoreId = leadsMatch[1];
        const campaignId = decodeURIComponent(leadsMatch[2]);
        this.authService.authorize(consumer, 'leads:read', targetStoreId);
        responseData = await this.handlers.listLeads(targetStoreId, campaignId, queryParams);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // GET /api/v1/stores/:store_id/campaigns/:campaign_id
      const campaignDetailMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/campaigns\/([^/]+)\/?$/);
      if (req.method === 'GET' && campaignDetailMatch) {
        targetStoreId = campaignDetailMatch[1];
        const campaignId = decodeURIComponent(campaignDetailMatch[2]);
        this.authService.authorize(consumer, 'campaigns:read', targetStoreId);
        responseData = await this.handlers.getCampaignDetail(targetStoreId, campaignId);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // GET /api/v1/stores/:store_id/campaigns
      const campaignsMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/campaigns\/?$/);
      if (req.method === 'GET' && campaignsMatch) {
        targetStoreId = campaignsMatch[1];
        this.authService.authorize(consumer, 'campaigns:read', targetStoreId);
        responseData = await this.handlers.listCampaigns(targetStoreId);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // --------------------------------------------------------
      // DOMAIN 4: LEADS
      // --------------------------------------------------------

      // GET /api/v1/stores/:store_id/leads/:voucher_code
      const leadByVoucherMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/leads\/([^/]+)\/?$/);
      if (req.method === 'GET' && leadByVoucherMatch) {
        targetStoreId = leadByVoucherMatch[1];
        const voucherCode = decodeURIComponent(leadByVoucherMatch[2]);
        this.authService.authorize(consumer, 'leads:read', targetStoreId);
        responseData = await this.handlers.getLeadByVoucher(targetStoreId, voucherCode);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // --------------------------------------------------------
      // DOMAIN 5: VOUCHERS
      // --------------------------------------------------------

      // POST /api/v1/stores/:store_id/vouchers/activate
      const voucherActivateMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/vouchers\/activate\/?$/);
      if (req.method === 'POST' && voucherActivateMatch) {
        targetStoreId = voucherActivateMatch[1];
        this.authService.authorize(consumer, 'vouchers:write', targetStoreId);
        const idempotencyKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;
        const body = await this.parseJsonBody(req);
        responseData = await this.handlers.activateVoucher(targetStoreId, consumer.id, idempotencyKey, body as any);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // POST /api/v1/stores/:store_id/vouchers/generate
      const voucherGenerateMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/vouchers\/generate\/?$/);
      if (req.method === 'POST' && voucherGenerateMatch) {
        targetStoreId = voucherGenerateMatch[1];
        this.authService.authorize(consumer, 'vouchers:write', targetStoreId);
        const idempotencyKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;
        const body = await this.parseJsonBody(req);
        responseData = await this.handlers.generateVoucher(targetStoreId, consumer.id, idempotencyKey, body as VoucherGenerateRequestPayload);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // GET /api/v1/stores/:store_id/vouchers/:voucher_code
      const voucherDetailMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/vouchers\/([^/]+)\/?$/);
      if (req.method === 'GET' && voucherDetailMatch) {
        targetStoreId = voucherDetailMatch[1];
        const voucherCode = decodeURIComponent(voucherDetailMatch[2]);
        this.authService.authorize(consumer, 'vouchers:read', targetStoreId);
        responseData = await this.handlers.getVoucherDetail(targetStoreId, voucherCode, queryParams);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // --------------------------------------------------------
      // DOMAIN 6: PRODUCTS & SERVICES (Catalog Domain)
      // --------------------------------------------------------

      // GET /api/v1/products/:product_code/services
      const productServicesMatch = pathname.match(/^\/api\/v1\/products\/([^/]+)\/services\/?$/);
      if (req.method === 'GET' && productServicesMatch) {
        this.authService.enforceScope(consumer, 'products:read');
        const productCode = decodeURIComponent(productServicesMatch[1]);
        responseData = await this.handlers.listProductServices(productCode);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // GET /api/v1/products/:product_code
      const productDetailMatch = pathname.match(/^\/api\/v1\/products\/([^/]+)\/?$/);
      if (req.method === 'GET' && productDetailMatch) {
        this.authService.enforceScope(consumer, 'products:read');
        const productCode = decodeURIComponent(productDetailMatch[1]);
        responseData = await this.handlers.getProductDetail(productCode);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // GET /api/v1/products
      if (req.method === 'GET' && pathname === '/api/v1/products') {
        this.authService.enforceScope(consumer, 'products:read');
        responseData = await this.handlers.listProducts(queryParams);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // --------------------------------------------------------
      // DOMAIN 7: FINANCIAL & DOCUMENTS
      // --------------------------------------------------------

      // GET /api/v1/stores/:store_id/financial/receivables
      const receivablesMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/financial\/receivables\/?$/);
      if (req.method === 'GET' && receivablesMatch) {
        targetStoreId = receivablesMatch[1];
        this.authService.authorize(consumer, 'financial:read', targetStoreId);
        responseData = await this.handlers.listReceivables(targetStoreId, queryParams);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // GET /api/v1/stores/:store_id/financial/boletos/:boleto_id
      const boletoMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/financial\/boletos\/([^/]+)\/?$/);
      if (req.method === 'GET' && boletoMatch) {
        targetStoreId = boletoMatch[1];
        const boletoId = decodeURIComponent(boletoMatch[2]);
        this.authService.authorize(consumer, 'financial:read', targetStoreId);
        responseData = await this.handlers.getBoleto(targetStoreId, boletoId, queryParams);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // GET /api/v1/stores/:store_id/financial/danfe/:nf_number
      const danfeMatch = pathname.match(/^\/api\/v1\/stores\/([^/]+)\/financial\/danfe\/([^/]+)\/?$/);
      if (req.method === 'GET' && danfeMatch) {
        targetStoreId = danfeMatch[1];
        const nfNumber = decodeURIComponent(danfeMatch[2]);
        this.authService.authorize(consumer, 'financial:read', targetStoreId);
        responseData = await this.handlers.getDanfe(targetStoreId, nfNumber, queryParams);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // --------------------------------------------------------
      // DOMAIN 8: ADMINISTRATIVE HISTORICAL ACCESS (SEGREGATED)
      // --------------------------------------------------------

      // GET /api/v1/admin/unassigned-orders
      if (req.method === 'GET' && pathname === '/api/v1/admin/unassigned-orders') {
        this.authService.enforceScope(consumer, 'admin:historical:read');
        responseData = await this.handlers.listUnassignedOrders(queryParams);
        this.sendJson(res, 200, { success: true, data: responseData });
        return;
      }

      // Route Not Found
      throw new ApiError(404, 'NOT_FOUND', `Cannot ${req.method} ${pathname}`);
    } catch (err) {
      this.handleError(res, err);
    }
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: StandardApiResponse): void {
    res.statusCode = statusCode;
    res.end(JSON.stringify(payload));
  }

  private handleError(res: http.ServerResponse, err: unknown): void {
    if (err instanceof ApiError) {
      this.sendJson(res, err.statusCode, {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          details: err.details
        }
      });
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error('ServingApi', `Unhandled server error: ${msg}`);
    this.sendJson(res, 500, {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal server error occurred'
      }
    });
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) { // 1MB limit
          reject(new ApiError(400, 'BAD_REQUEST', 'Request payload too large'));
        }
      });
      req.on('end', () => {
        if (!body || body.trim() === '') {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new ApiError(400, 'BAD_REQUEST', 'Malformed JSON payload'));
        }
      });
      req.on('error', reject);
    });
  }
}

async function main() {
  const logger = new ConsoleLogger();
  const port = parseInt(process.env.PORT || process.env.API_PORT || '3000', 10);
  logger.info('ServingApi', `Initializing Serving API server on port ${port}...`);

  let pool: import('pg').Pool | undefined;
  try {
    pool = createPgPool();
    const db = new PgDatabaseExecutor(pool);
    const server = new ServingApiServer({ db, logger, port });
    await server.listen(port);
    logger.info('ServingApi', `Serving API server successfully running on port ${port}`);

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('ServingApi', 'Shutting down Serving API server...');
      await server.close();
      if (pool) {
        await pool.end();
      }
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('ServingApi', `Fatal error starting Serving API: ${msg}`);
    if (pool) {
      await pool.end();
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal unhandled error in Serving API:', err);
    process.exit(1);
  });
}
