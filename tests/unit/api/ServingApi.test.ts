import { ServingApiServer } from '../../../src/api/server';
import { ConsumerAuthService } from '../../../src/api/auth';
import { IDatabaseExecutor } from '../../../src/config/db';
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
    allowed_scopes: ['orders:read', 'tracking:read', 'campaigns:read', 'vouchers:write'],
    allowed_store_ids: ['store-uuid-1'], // Can only access store-uuid-1
    credential_id: 'cred-uuid-1',
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
  // 1. Authentication Tests
  // ----------------------------------------------------------

  it('GET /api/v1/health should be publicly accessible without credentials', async () => {
    const res = await makeRequest('GET', '/api/v1/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
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

  // ----------------------------------------------------------
  // 2. Cross-Store Security & Isolation Tests
  // ----------------------------------------------------------

  it('should return 403 STORE_ACCESS_DENIED when consumer attempts to access an unauthorized store', async () => {
    // Consumer has access ONLY to store-uuid-1. Attempting access to store-uuid-2:
    mockDb.query.mockResolvedValueOnce([consumerStore1]);

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-2/orders', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('STORE_ACCESS_DENIED');
  });

  it('should return 200 OK and strictly filter orders by store_id for authorized store', async () => {
    // Mock authentication
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth query
      .mockResolvedValueOnce([]) // last_used_at update
      .mockResolvedValueOnce([{ count: '1' }]) // Count query
      .mockResolvedValueOnce([
        {
          id: 'order-1',
          order_number: 'ORD-STORE1-100',
          status: 'Entregue',
          store_id: 'store-uuid-1',
        },
      ]); // Data query

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.orders).toHaveLength(1);
    expect(res.body.data.orders[0].order_number).toBe('ORD-STORE1-100');

    // Verify the query strictly filtered by store_id = $1
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('store_id = $1'),
      expect.arrayContaining(['store-uuid-1'])
    );
  });

  // ----------------------------------------------------------
  // 3. Administrative Historical Access (Segregated)
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
      .mockResolvedValueOnce([{ count: '7234' }]) // Count unassigned orders
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
    expect(res.body.data.pagination.total).toBe(7234);

    // Verify query explicitly looked for store_id IS NULL
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('store_id IS NULL')
    );
  });

  // ----------------------------------------------------------
  // 4. Idempotency & Voucher Activation
  // ----------------------------------------------------------

  it('should reject voucher activation when Idempotency-Key header is missing', async () => {
    mockDb.query.mockResolvedValueOnce([consumerStore1]);

    const res = await makeRequest(
      'POST',
      '/api/v1/stores/store-uuid-1/vouchers/activate',
      { Authorization: `Bearer ${validToken}` },
      { campaignId: 'CAMP-01', voucherCode: 'VOUCHER-123' }
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('should replay previous result without re-executing when same Idempotency-Key is sent', async () => {
    const requestBody = { campaignId: 'CAMP-01', voucherCode: 'VOUCHER-123' };
    const payloadHash = require('crypto').createHash('sha256').update(JSON.stringify(requestBody)).digest('hex');
    const cachedResponse = { voucherCode: 'VOUCHER-123', activated: true, transactionId: 'TX-999' };

    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([
        {
          id: 'op-uuid-cached',
          status: 'completed',
          request_hash: payloadHash,
          external_reference: JSON.stringify(cachedResponse),
        },
      ]); // Existing idempotency operation

    const res = await makeRequest(
      'POST',
      '/api/v1/stores/store-uuid-1/vouchers/activate',
      {
        Authorization: `Bearer ${validToken}`,
        'Idempotency-Key': 'idemp-key-test-01',
      },
      requestBody
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.activated).toBe(true);
    expect(res.body.data._replayed).toBe(true);
  });

  // ----------------------------------------------------------
  // 5. Extended Security, Header & Isolation Tests (ML-005)
  // ----------------------------------------------------------

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

  it('should return 404 NOT_FOUND for getOrderDetail when order does not belong to the store', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([]); // Order not found for store-uuid-1

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/orders/ORD-OTHER-STORE', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('ORD-OTHER-STORE');
  });

  it('should return 404 NOT_FOUND for getTrackingByNf when NF does not belong to the store', async () => {
    mockDb.query
      .mockResolvedValueOnce([consumerStore1]) // Auth
      .mockResolvedValueOnce([]) // last_used_at
      .mockResolvedValueOnce([]); // NF not found for store-uuid-1

    const res = await makeRequest('GET', '/api/v1/stores/store-uuid-1/tracking/999999', {
      Authorization: `Bearer ${validToken}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('999999');
  });

  it('should reject requests with payload exceeding 1MB limit', async () => {
    mockDb.query.mockResolvedValueOnce([consumerStore1]);

    // Construct a payload larger than 1MB
    const largePadding = 'X'.repeat(1024 * 1024 + 50);
    const largeBody = { campaignId: 'CAMP-01', voucherCode: 'V123', padding: largePadding };

    const res = await makeRequest(
      'POST',
      '/api/v1/stores/store-uuid-1/vouchers/activate',
      {
        Authorization: `Bearer ${validToken}`,
        'Idempotency-Key': 'idemp-large-test',
      },
      largeBody
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('payload too large');
  });
});

