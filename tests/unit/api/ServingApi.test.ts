import { ServingApiServer } from '../../../src/api/server';
import { ConsumerAuthService } from '../../../src/api/auth';
import { IDatabaseExecutor } from '../../../src/config/db';
import { VouchersProvider } from '../../../src/providers/vouchers';
import { FinancialProvider } from '../../../src/providers/financial';
import * as http from 'http';

describe('Serving API (Consumer Authentication, Scopes, Store Isolation & Idempotency)', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let apiServer: ServingApiServer;
  let port: number;
  let baseUrl: string;

  const validToken = 'zeiss_sec_live_999999999999';
  const validTokenHash = ConsumerAuthService.hashSecret(validToken);

  const consumerStore1 = {
    id: 'consumer-uuid-1',
    client_id: 'pos-store-1',
    display_name: 'POS Terminal Store 1',
    enabled: true,
    allowed_scopes: [
      'orders:read',
      'tracking:read',
      'campaigns:read',
      'leads:read',
      'vouchers:read',
      'vouchers:write',
      'products:read',
      'financial:read',
    ],
    allowed_store_ids: ['store-uuid-1'], // Can only access store-uuid-1
    credential_id: 'cred-uuid-1',
    expires_at: null,
    revoked_at: null,
  };

  const restrictedConsumer = {
    id: 'consumer-restricted',
    client_id: 'reports-only',
    display_name: 'Reports Only Consumer',
    enabled: true,
    allowed_scopes: ['orders:read'], // Only orders:read
    allowed_store_ids: ['store-uuid-1'],
    credential_id: 'cred-uuid-restricted',
    expires_at: null,
    revoked_at: null,
  };

  const adminConsumer = {
    id: 'admin-uuid-1',
    client_id: 'data-lake-ingestion',
    display_name: 'Data Lake Admin Ingestion',
    enabled: true,
    allowed_scopes: ['admin:historical:read', '*'],
    allowed_store_ids: ['*'], // Super-consumer
    credential_id: 'cred-uuid-admin',
    expires_at: null,
    revoked_at: null,
  };

  beforeEach(() => {
    mockDb.query = jest.fn().mockResolvedValue([]);
    mockDb.transaction = jest.fn();
  });

  beforeAll(async () => {
    mockDb = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(),
    };

    apiServer = new ServingApiServer({
      db: mockDb,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    });

    port = await apiServer.listen(0); // Random available ephemeral port
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await apiServer.close();
  });

  // Helper function to send HTTP requests to test server
  function makeRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(
        url,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve({
                statusCode: res.statusCode || 0,
                headers: res.headers,
                body: data ? JSON.parse(data) : null,
              });
            } catch {
              resolve({
                statusCode: res.statusCode || 0,
                headers: res.headers,
                body: data,
              });
            }
          });
        }
      );
      req.on('error', reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  // ----------------------------------------------------------
  // 1. Authentication & Common Middleware Tests
  // ----------------------------------------------------------

  it('GET /api/v1/health should be publicly accessible without credentials', async () => {
    const res = await makeRequest('GET', '/api/v1/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
  });

  it('OPTIONS should respond with 204 No Content for CORS preflight', async () => {
    const res = await makeRequest('OPTIONS', '/api/v1/stores/store-uuid-1/orders');
    expect(res.statusCode).toBe(204);
  });

  it('should return 401 UNAUTHORIZED when no credentials are provided', async () => {
    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders');
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should return 401 INVALID_CREDENTIALS when token is unknown', async () => {
    mockDb.query.mockResolvedValueOnce([]); // No row found for hash

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders', {
      Authorization: 'Bearer invalid_secret_token_123',
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('should return 403 FORBIDDEN when consumer account is disabled', async () => {
    mockDb.query.mockResolvedValueOnce([{ ...consumerStore1, enabled: false }]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders', {
      Authorization: `Bearer ${validToken}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('should return 401 TOKEN_REVOKED when credential has been revoked', async () => {
    mockDb.query.mockResolvedValueOnce([{ ...consumerStore1, revoked_at: new Date() }]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders', {
      Authorization: `Bearer ${validToken}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_REVOKED');
  });

  it('should return 401 TOKEN_EXPIRED when credential is past expiration date', async () => {
    mockDb.query.mockResolvedValueOnce([{ ...consumerStore1, expires_at: new Date('2020-01-01') }]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders', {
      Authorization: `Bearer ${validToken}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('should authenticate successfully using X-API-Key header', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders', {
      'X-API-Key': validToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // ----------------------------------------------------------
  // 2. Cross-Store Security & Isolation Tests
  // ----------------------------------------------------------

  it('should return 403 STORE_ACCESS_DENIED when consumer attempts to access an unauthorized store', async () => {
    mockDb.query.mockResolvedValueOnce([consumerStore1]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-2/orders', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('STORE_ACCESS_DENIED');
  });

  it('should return 403 INSUFFICIENT_SCOPE when consumer lacks required scope', async () => {
    mockDb.query.mockResolvedValueOnce([restrictedConsumer]); // Only has orders:read

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/campaigns', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  // ----------------------------------------------------------
  // 3. Orders Domain
  // ----------------------------------------------------------

  it('GET /api/v1/stores/:store_id/orders returns filtered and paginated list', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([{ count: '1' }]) // Count query
      .mockResolvedValueOnce([
        {
          id: 'ord-1',
          order_number: 'ORD-100',
          os_number: 'OS-100',
          status: 'Entregue',
          codsit: '6.1',
          entry_date: '2026-08-01',
          expected_date: '2026-08-10',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]); // Data query

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders?status=Entregue&page=1&limit=10', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.orders).toHaveLength(1);
    expect(res.body.data.orders[0].order_number).toBe('ORD-100');
    expect(res.body.data.pagination.total).toBe(1);
  });

  it('GET /api/v1/stores/:store_id/orders/:order_number returns order details and fiscal documents', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        {
          id: 'ord-uuid-1',
          order_number: 'ORD-100',
          os_number: 'OS-100',
          status: 'Faturado',
          detail_status: '6.1',
          detail_situacao: 'Pronto para Envio',
        },
      ]) // Order query
      .mockResolvedValueOnce([
        { id: 'fd-1', nf_number: '123456', nf_series: '1', created_at: new Date().toISOString() },
      ]); // Fiscal docs query

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders/ORD-100', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.order_number).toBe('ORD-100');
    expect(res.body.data.fiscal_documents).toHaveLength(1);
  });

  it('GET /api/v1/stores/:store_id/orders/:order_number/fiscal-documents returns linked documents', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        { id: 'fd-1', order_id: 'ord-1', nf_number: '98765', nf_series: '1', order_number: 'ORD-100' },
      ]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders/ORD-100/fiscal-documents', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.documents).toHaveLength(1);
    expect(res.body.data.documents[0].nf_number).toBe('98765');
  });

  // ----------------------------------------------------------
  // 4. Tracking Domain
  // ----------------------------------------------------------

  it('GET /api/v1/stores/:store_id/tracking/:nf_number returns tracking events by NF', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        {
          id: 'trk-1',
          order_id: 'ord-1',
          order_number: 'ORD-100',
          nf_number: '12345',
          status: 'ENTREGUE',
          event_date: new Date().toISOString(),
        },
      ]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/tracking/12345', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0].status).toBe('ENTREGUE');
  });

  it('GET /api/v1/stores/:store_id/orders/:order_number/tracking returns tracking events by order', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        {
          id: 'trk-1',
          order_number: 'ORD-100',
          nf_number: '12345',
          status: 'EM_TRANSITO',
        },
      ]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders/ORD-100/tracking', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0].status).toBe('EM_TRANSITO');
  });

  // ----------------------------------------------------------
  // 5. Campaigns & Leads Domain
  // ----------------------------------------------------------

  it('GET /api/v1/stores/:store_id/campaigns returns active campaigns with store adhesion', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        {
          id: 'c-1',
          campaign_id: 'CAMP-ZEISS-2026',
          title: 'Campanha de Primavera',
          global_status: 'S',
          store_status: 'S',
          aceite: true,
          incentive_type: 'VOUCHER',
        },
      ]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/campaigns', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.campaigns).toHaveLength(1);
    expect(res.body.data.campaigns[0].campaign_id).toBe('CAMP-ZEISS-2026');
    expect(res.body.data.campaigns[0].aceite).toBe(true);
  });

  it('GET /api/v1/stores/:store_id/campaigns/:campaign_id returns campaign detail', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        {
          id: 'c-1',
          campaign_id: 'CAMP-ZEISS-2026',
          title: 'Campanha de Primavera',
          aceite: true,
        },
      ]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/campaigns/CAMP-ZEISS-2026', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.title).toBe('Campanha de Primavera');
  });

  it('GET /api/v1/stores/:store_id/campaigns/:campaign_id/leads returns pseudonymized leads without raw PII', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([{ count: '1' }]) // Count
      .mockResolvedValueOnce([
        {
          id: 'l-1',
          campaign_id: 'CAMP-ZEISS-2026',
          voucher_code: 'VCH-12345',
          status: 'Disponivel',
          email_hmac: 'a64eb8a5058a4f5696340ec1ddfb45341234567890abcdef1234567890abcdef',
        },
      ]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/campaigns/CAMP-ZEISS-2026/leads', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.leads).toHaveLength(1);
    expect(res.body.data.leads[0].email_hmac).toBeDefined();
    // Verify no raw email or name exists in record
    expect(res.body.data.leads[0].email).toBeUndefined();
    expect(res.body.data.leads[0].name).toBeUndefined();
  });

  it('GET /api/v1/stores/:store_id/leads/:voucher_code returns lead by voucher', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        {
          id: 'l-1',
          campaign_id: 'CAMP-ZEISS-2026',
          voucher_code: 'VCH-5555',
          status: 'Resgatado',
          email_hmac: 'hmac-hash-sample',
        },
      ]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/leads/VCH-5555', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.voucher_code).toBe('VCH-5555');
  });

  // ----------------------------------------------------------
  // 6. Vouchers Domain & Mutations
  // ----------------------------------------------------------

  it('GET /api/v1/stores/:store_id/vouchers/:voucher_code returns voucher from local repository', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        {
          id: 'v-1',
          voucher_code: 'VCH-888',
          campaign_id: 'CAMP-01',
          status: 'Ativo',
        },
      ]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/vouchers/VCH-888', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.voucher_code).toBe('VCH-888');
  });

  it('POST /api/v1/stores/:store_id/vouchers/activate rejects with 403 MUTATION_DISABLED if mutations switch is off', async () => {
    const originalEnv = process.env.ALLOW_EXTERNAL_MUTATIONS;
    delete process.env.ALLOW_EXTERNAL_MUTATIONS;

    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]); // last_used_at

    const res = await makeRequest(
      'POST',
      '/api/v1/stores/store-uuid-1/vouchers/activate',
      {
        Authorization: `Bearer ${validToken}`,
        'Idempotency-Key': 'idemp-activate-disabled',
      },
      { campaignId: 'CAMP-01', voucherCode: 'VCH-123' }
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('MUTATION_DISABLED');

    process.env.ALLOW_EXTERNAL_MUTATIONS = originalEnv;
  });

  it('POST /api/v1/stores/:store_id/vouchers/generate rejects with 400 when Idempotency-Key is missing', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]); // last_used_at

    const res = await makeRequest(
      'POST',
      '/api/v1/stores/store-uuid-1/vouchers/generate',
      { Authorization: `Bearer ${validToken}` },
      { campaignId: 'CAMP-01', name: 'João Silva', email: 'joao@example.com' }
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('POST /api/v1/stores/:store_id/vouchers/generate replays cached result when duplicate idempotency key is sent', async () => {
    process.env.ALLOW_EXTERNAL_MUTATIONS = 'true';

    const reqBody = { campaignId: 'CAMP-01', name: 'Maria Souza', email: 'maria@example.com' };
    const payloadHash = require('crypto').createHash('sha256').update(JSON.stringify(reqBody)).digest('hex');
    const cachedResponse = { voucherCode: 'VCH-NEW-999', generated: true };

    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        {
          id: 'op-generate-cached',
          status: 'SUCCEEDED',
          request_hash: payloadHash,
          external_reference: JSON.stringify(cachedResponse),
        },
      ]); // Idempotency check

    const res = await makeRequest(
      'POST',
      '/api/v1/stores/store-uuid-1/vouchers/generate',
      {
        Authorization: `Bearer ${validToken}`,
        'Idempotency-Key': 'idemp-gen-01',
      },
      reqBody
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.voucherCode).toBe('VCH-NEW-999');
    expect(res.body.data._replayed).toBe(true);

    delete process.env.ALLOW_EXTERNAL_MUTATIONS;
  });

  // ----------------------------------------------------------
  // 7. Products & Services Domain
  // ----------------------------------------------------------

  it('GET /api/v1/products returns paginated product list', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([{ count: '2' }]) // Count
      .mockResolvedValueOnce([
        { id: 'p-1', zeiss_product_code: 'ZP-01', name: 'Lente ZEISS Single Vision', category: 'Monofocal' },
        { id: 'p-2', zeiss_product_code: 'ZP-02', name: 'Lente ZEISS Progressive', category: 'Progressiva' },
      ]); // Products

    const res = await makeRequest('GET', '/api/v1/products?page=1&limit=10', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.products).toHaveLength(2);
    expect(res.body.data.pagination.total).toBe(2);
  });

  it('GET /api/v1/products/:product_code returns product detail', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        { id: 'p-1', zeiss_product_code: 'ZP-01', name: 'Lente ZEISS Single Vision', material: 'Orgânica 1.5' },
      ]);

    const res = await makeRequest('GET', '/api/v1/products/ZP-01', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.zeiss_product_code).toBe('ZP-01');
    expect(res.body.data.material).toBe('Orgânica 1.5');
  });

  it('GET /api/v1/products/:product_code/services returns services associated with product', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([{ id: 'p-1', name: 'Lente ZEISS Single Vision' }]) // Product check
      .mockResolvedValueOnce([
        { id: 's-1', service_code: 'DuraVision Platinum', service_name: 'Antirreflexo Premium' },
        { id: 's-2', service_code: 'PhotoFusion X', service_name: 'Fotossensível' },
      ]); // Services

    const res = await makeRequest('GET', '/api/v1/products/ZP-01/services', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.productCode).toBe('ZP-01');
    expect(res.body.data.services).toHaveLength(2);
  });

  // ----------------------------------------------------------
  // 8. Financial Domain
  // ----------------------------------------------------------

  it('GET /api/v1/stores/:store_id/financial/receivables returns receivables list', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([{ count: '1' }]) // Count
      .mockResolvedValueOnce([
        {
          id: 'rec-1',
          boleto_number: 'BOL-123456789',
          fiscal_reference: 'NF-100',
          amount: '1250.00',
          status: 'Aberto',
          due_date: '2026-11-15',
        },
      ]); // Receivables

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/financial/receivables', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.receivables).toHaveLength(1);
    expect(res.body.data.receivables[0].boleto_number).toBe('BOL-123456789');
  });

  it('GET /api/v1/stores/:store_id/financial/boletos/:boleto_id rejects 400 when dueDate cannot be resolved', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([]); // No receivable found to deduce dueDate

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/financial/boletos/BOL-NONEXISTENT', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('dueDate');
  });

  // ----------------------------------------------------------
  // 9. Administrative Historical Segregation
  // ----------------------------------------------------------

  it('should return 403 INSUFFICIENT_SCOPE when standard consumer tries to access unassigned historical orders', async () => {
    mockDb.query.mockResolvedValueOnce([consumerStore1]); // Standard consumer without admin:historical:read

    const res = await makeRequest('GET', '/api/v1/admin/unassigned-orders', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('should allow admin consumer with admin:historical:read to inspect orders where store_id IS NULL', async () => {
    mockDb.query
      .mockResolvedValueOnce([adminConsumer]) // Auth query
      .mockResolvedValueOnce([]) // last_used_at update
      .mockResolvedValueOnce([{ count: '7235' }]) // Count unassigned orders
      .mockResolvedValueOnce([
        { id: 'hist-1', order_number: 'ORD-HIST-01', store_id: null },
        { id: 'hist-2', order_number: 'ORD-HIST-02', store_id: null },
      ]); // Orders data

    const res = await makeRequest('GET', '/api/v1/admin/unassigned-orders', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.orders).toHaveLength(2);
    expect(res.body.data.pagination.total).toBe(7235);

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('store_id IS NULL')
    );
  });
});
