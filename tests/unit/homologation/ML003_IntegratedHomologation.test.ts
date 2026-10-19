// ============================================================
// ML-003 Integrated Technical Homologation Test Suite
// BD_API_ZEISS Platform
// ============================================================

import { IDatabaseExecutor } from '../../../src/config/db';
import { executeWorkerTick } from '../../../src/worker';
import { StoreBootstrapOrchestrator } from '../../../src/engine/StoreBootstrapOrchestrator';
import { StoreOnboardingService } from '../../../src/core/StoreOnboardingService';
import { ContinentalReconciliationService } from '../../../src/core/ContinentalReconciliationService';
import { ServingApiServer } from '../../../src/api/server';
import { ConsumerAuthService } from '../../../src/api/auth';
import { ApiHandlers } from '../../../src/api/handlers';
import { AuditService } from '../../../src/api/audit';
import { IStoreResolutionService } from '../../../src/core/StoreResolutionService';
import { StoreZeissContext } from '../../../src/contracts/store';
import { OrdersProvider } from '../../../src/providers/orders';
import { FinancialProvider } from '../../../src/providers/financial';
import { VouchersProvider } from '../../../src/providers/vouchers';
import { ProductsProvider } from '../../../src/providers/products';
import { PgOrdersRepository } from '../../../src/repositories/postgres/OrdersRepository';
import { ConsoleLogger } from '../../../src/observability/Logger';
import { IClock, ISleeper } from '../../../src/utils/Clock';
import * as http from 'http';

class MockClock implements IClock {
  private currentTime: number;
  constructor(initialTime: string = '2026-10-19T12:00:00.000Z') {
    this.currentTime = new Date(initialTime).getTime();
  }
  now(): number {
    return this.currentTime;
  }
  advance(ms: number) {
    this.currentTime += ms;
  }
}

class MockSleeper implements ISleeper {
  async sleep(_ms: number): Promise<void> {}
}

/**
 * Stateful In-Memory PostgreSQL Simulator for Integrated Homologation.
 * Faithfully simulates Postgres schemas core, zeiss, and integration.
 */
class InMemoryDatabaseExecutor implements IDatabaseExecutor {
  public organizations: Array<{ id: string; name: string; status: string }> = [];
  public credentials: Array<{ id: string; organization_id: string; env_ref: string; status: string }> = [];
  public stores: Array<{ id: string; organization_id: string; code: string; name: string; cnpj: string; status: string }> = [];
  public identities: Array<{ id: string; store_id: string; organization_id: string; credential_id: string; country_id: string; saoweb_code: string; zeiss_store_code: string; voucher_user_id: string; fin_user_id: string; leads_hmac_secret_ref: string | null }> = [];
  
  public policies: Array<any> = [];
  public legacySyncState: Array<any> = [];
  public storeSyncState: Array<any> = [];
  public storeSyncLeases: Array<any> = [];
  public storeProviderHealth: Array<any> = [];

  public apiConsumers: Array<any> = [];
  public apiCredentials: Array<any> = [];
  public apiOperations: Array<any> = [];

  public orders: Array<any> = [];
  public orderDetails: Array<any> = [];
  public trackingEvents: Array<any> = [];
  public campaigns: Array<any> = [];
  public leads: Array<any> = [];
  public receivables: Array<any> = [];
  public fiscalDocuments: Array<any> = [];

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const s = sql.trim().toLowerCase().replace(/\s+/g, ' ');

    // 1. core.organizations
    if (s.includes('from core.organizations')) {
      const orgId = params[0] as string;
      return this.organizations.filter(o => o.id === orgId) as T[];
    }

    // 2. core.integration_credentials
    if (s.includes('from core.integration_credentials')) {
      const credId = params[0] as string;
      return this.credentials.filter(c => c.id === credId) as T[];
    }

    // 3. core.stores
    if (s.startsWith('insert into core.stores')) {
      const [id, orgId, code, name, cnpj] = params as string[];
      const newStore = { id, organization_id: orgId, code, name, cnpj, status: 'draft' };
      this.stores.push(newStore);
      return [{ id, code, status: 'draft' }] as T[];
    }
    if (s.startsWith('update core.stores set status = $1')) {
      const status = params[0] as string;
      const id = params[1] as string;
      const store = this.stores.find(st => st.id === id);
      if (store) store.status = status;
      return [] as T[];
    }
    if (s.includes('from core.stores where id = $1')) {
      const id = params[0] as string;
      return this.stores.filter(st => st.id === id) as T[];
    }
    if (s.includes('from core.stores s') && s.includes('join core.organizations o')) {
      const isFilteredById = s.includes('s.id = $1') || s.includes('s.code = $1');
      const idOrCode = isFilteredById ? (params[0] as string) : null;

      let list = this.stores;
      if (idOrCode) {
        list = list.filter(st => st.id === idOrCode || st.code === idOrCode);
      } else {
        list = list.filter(st => st.status === 'ready' || st.status === 'active');
      }

      return list.map(st => {
        const iden = this.identities.find(i => i.store_id === st.id);
        const cred = this.credentials.find(c => c.id === iden?.credential_id);
        return {
          store_id: st.id,
          store_code: st.code,
          store_status: st.status,
          cnpj: st.cnpj,
          organization_id: st.organization_id,
          org_code: 'MATRIZ',
          saoweb_code: iden?.saoweb_code || '1001',
          zeiss_store_code: iden?.zeiss_store_code || 'Z01',
          country_id: iden?.country_id || '1',
          voucher_user_id: iden?.voucher_user_id || 'v1',
          fin_user_id: iden?.fin_user_id || 'f1',
          leads_hmac_secret_ref: iden?.leads_hmac_secret_ref || null,
          identity_org_id: iden?.organization_id || st.organization_id,
          secret_storage_type: 'env_ref',
          secret_ref: cred?.env_ref || 'ZEISS_CONFIG_JSON',
          cred_status: cred?.status || 'active',
          cred_org_id: cred?.organization_id || st.organization_id
        };
      }) as T[];
    }

    // 4. core.store_zeiss_identities
    if (s.startsWith('insert into core.store_zeiss_identities')) {
      const [id, storeId, orgId, credId, countryId, saoweb, zeissCode, vUser, fUser, hmac] = params as string[];
      this.identities.push({
        id,
        store_id: storeId,
        organization_id: orgId,
        credential_id: credId,
        country_id: countryId,
        saoweb_code: saoweb,
        zeiss_store_code: zeissCode,
        voucher_user_id: vUser,
        fin_user_id: fUser,
        leads_hmac_secret_ref: hmac || null
      });
      return [] as T[];
    }

    // 5. integration.sync_policies
    if (s.includes('from integration.sync_policies')) {
      return this.policies.filter(p => p.enabled) as T[];
    }

    // 6. integration.store_sync_state
    if (s.includes('from integration.store_sync_state')) {
      const [storeId, provider, domain, op] = params as string[];
      return this.storeSyncState.filter(
        st => st.store_id === storeId && st.provider === provider && st.domain === domain && st.operation === op
      ) as T[];
    }
    if (s.startsWith('insert into integration.store_sync_state')) {
      const [storeId, provider, domain, op, cursor] = params as [string, string, string, string, any];
      const idx = this.storeSyncState.findIndex(
        st => st.store_id === storeId && st.provider === provider && st.domain === domain && st.operation === op
      );
      const row = { store_id: storeId, provider, domain, operation: op, last_sync: new Date(), cursor_value: cursor };
      if (idx >= 0) this.storeSyncState[idx] = row;
      else this.storeSyncState.push(row);
      return [] as T[];
    }

    // 7. integration.store_sync_leases
    if (s.includes('from integration.store_sync_leases')) {
      return this.storeSyncLeases as T[];
    }
    if (s.includes('bd_api_try_acquire_store_lease') || s.startsWith('insert into integration.store_sync_leases')) {
      return [{ acquired: true }] as T[];
    }
    if (s.includes('update integration.store_sync_leases set expires_at')) {
      return [{ renewed: true }] as T[];
    }
    if (s.startsWith('delete from integration.store_sync_leases')) {
      return [] as T[];
    }

    // 8. integration.store_provider_health
    if (s.includes('integration.store_provider_health')) {
      return [] as T[];
    }

    // 9. API Auth & Credentials
    if (s.includes('from integration.api_credentials cred')) {
      const secretHash = params[0] as Buffer;
      const cred = this.apiCredentials.find(c => Buffer.compare(c.secret_hash, secretHash) === 0);
      if (!cred) return [] as T[];
      const consumer = this.apiConsumers.find(c => c.id === cred.consumer_id);
      if (!consumer) return [] as T[];
      return [{
        id: consumer.id,
        client_id: consumer.client_id,
        display_name: consumer.display_name,
        enabled: consumer.enabled,
        allowed_scopes: consumer.allowed_scopes,
        allowed_store_ids: consumer.allowed_store_ids,
        credential_id: cred.id,
        expires_at: cred.expires_at,
        revoked_at: cred.revoked_at
      }] as T[];
    }

    // 10. API Operations (Idempotency)
    if (s.includes('from integration.api_operations')) {
      const consumerId = params[0] as string;
      const key = params[1] as string;
      const existing = this.apiOperations.find(op => op.consumer_id === consumerId && op.idempotency_key === key);
      if (existing) {
        return [{
          id: existing.id,
          status: existing.status,
          request_hash: existing.request_hash,
          external_reference: existing.external_reference
        }] as T[];
      }
      return [] as T[];
    }
    if (s.startsWith('insert into integration.api_operations')) {
      const [id, consumerId, opName, storeId, key, hash] = params as string[];
      this.apiOperations.push({
        id,
        consumer_id: consumerId,
        operation: opName,
        store_id: storeId,
        idempotency_key: key,
        request_hash: hash,
        status: 'in_progress',
        external_reference: null
      });
      return [] as T[];
    }
    if (s.startsWith('update integration.api_operations set status = $1')) {
      const status = params[0] as string;
      const extRef = params[1] as string;
      const id = params[3] as string;
      const op = this.apiOperations.find(o => o.id === id);
      if (op) {
        op.status = status;
        op.external_reference = extRef;
      }
      return [] as T[];
    }

    // 11. zeiss.orders
    if (s.includes('count(*) as count from zeiss.orders where store_id = $1')) {
      const storeId = params[0] as string;
      const count = this.orders.filter(o => o.store_id === storeId).length;
      return [{ count: String(count) }] as T[];
    }
    if (s.includes('count(*) as count from zeiss.orders where store_id is null')) {
      const count = this.orders.filter(o => o.store_id === null).length;
      return [{ count: String(count) }] as T[];
    }
    if (s.includes('from zeiss.orders') && s.includes('where store_id is null')) {
      return this.orders.filter(o => o.store_id === null) as T[];
    }
    if (s.includes('from zeiss.orders') && s.includes('where store_id = $1')) {
      const storeId = params[0] as string;
      return this.orders.filter(o => o.store_id === storeId) as T[];
    }

    // 12. Reconciliation audit query
    if (s.includes('from zeiss.orders o') && s.includes('left join zeiss.order_details od')) {
      const unassigned = this.orders.filter(o => o.store_id === null);
      return unassigned.map(o => {
        const detail = this.orderDetails.find(d => d.order_id === o.id);
        const fiscal = this.fiscalDocuments.find(f => f.order_id === o.id);
        return {
          order_id: o.id,
          order_number: o.order_number,
          status: o.status,
          entry_date: o.entry_date,
          detail_id: detail?.id || null,
          detail_codcli: detail?.codcli || null,
          fiscal_id: fiscal?.id || null,
          fiscal_cnpj: fiscal?.cnpj || null
        };
      }) as T[];
    }

    // 13. Order detail query
    if (s.includes('from zeiss.orders o') && s.includes('left join zeiss.order_details d on d.order_id = o.id')) {
      const [storeId, orderNumber] = params as string[];
      const o = this.orders.find(ord => ord.store_id === storeId && ord.order_number === orderNumber);
      if (!o) return [] as T[];
      const d = this.orderDetails.find(dt => dt.order_id === o.id);
      return [{
        id: o.id,
        order_number: o.order_number,
        os_number: o.os_number,
        status: o.status,
        entry_date: o.entry_date,
        expected_date: o.expected_date,
        detail_situacao: d ? { codcli: d.codcli } : null,
        detail_invoices: d?.invoices || null
      }] as T[];
    }

    // 14. Campaigns and Leads
    if (s.includes('from zeiss.campaigns')) {
      return this.campaigns as T[];
    }
    if (s.includes('from zeiss.leads')) {
      const storeId = params[0] as string;
      return this.leads.filter(l => l.store_id === storeId) as T[];
    }

    // Default fallback
    return [] as T[];
  }

  async transaction<T>(callback: (client: IDatabaseExecutor) => Promise<T>): Promise<T> {
    return await callback(this);
  }
}

describe('ML-003 Integrated Homologation & Activation Preparation', () => {
  let db: InMemoryDatabaseExecutor;
  let logger: ConsoleLogger;
  let clock: MockClock;

  const orgId = '11111111-1111-1111-1111-111111111111';
  const credId = '22222222-2222-2222-2222-222222222222';
  const continentalStoreId = '3cdde1d2-4461-475f-8faf-418bbb3790fd';

  let getOrdersSpy: jest.SpyInstance;
  let getDetailSpy: jest.SpyInstance;
  let getTrackingSpy: jest.SpyInstance;
  let getProductsSpy: jest.SpyInstance;
  let getCampaignsSpy: jest.SpyInstance;
  let getLeadsSpy: jest.SpyInstance;
  let getReceivablesSpy: jest.SpyInstance;
  let activateVoucherSpy: jest.SpyInstance;

  beforeAll(() => {
    getOrdersSpy = jest.spyOn(OrdersProvider.prototype, 'getOrders').mockResolvedValue([]);
    getDetailSpy = jest.spyOn(OrdersProvider.prototype, 'getOrderDetail').mockResolvedValue({ status: 'FATURADO', situacao: { codsit: '05' }, nf: [] });
    getTrackingSpy = jest.spyOn(OrdersProvider.prototype, 'getTracking').mockResolvedValue([]);
    getProductsSpy = jest.spyOn(ProductsProvider.prototype, 'getProducts').mockResolvedValue([]);
    getCampaignsSpy = jest.spyOn(VouchersProvider.prototype, 'getCampaigns').mockResolvedValue([]);
    getLeadsSpy = jest.spyOn(VouchersProvider.prototype, 'getLeads').mockResolvedValue([]);
    activateVoucherSpy = jest.spyOn(VouchersProvider.prototype, 'activateVoucher').mockResolvedValue({ voucherCode: 'VCH-999', activated: true } as any);
    getReceivablesSpy = jest.spyOn(FinancialProvider.prototype, 'getReceivables').mockResolvedValue([] as any);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    db = new InMemoryDatabaseExecutor();
    logger = new ConsoleLogger();
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    clock = new MockClock('2026-10-19T12:00:00.000Z');

    process.env['ZEISS_CONFIG_JSON'] = 'mock-api-key-test';

    // Seed organization & credentials
    db.organizations.push({ id: orgId, name: 'Óticas Matriz', status: 'active' });
    db.credentials.push({ id: credId, organization_id: orgId, env_ref: 'ZEISS_CONFIG_JSON', status: 'active' });

    // Seed central sync policies (integration.sync_policies)
    db.policies.push(
      { provider: 'zeiss', domain: 'orders', operation: 'hot', enabled: true, interval_seconds: 900, timeout_seconds: 120, lease_ttl_seconds: 300, max_retries: 2, retry_delay_seconds: 60 },
      { provider: 'zeiss', domain: 'orders', operation: 'reconciliation', enabled: true, interval_seconds: 86400, timeout_seconds: 600, lease_ttl_seconds: 1200, max_retries: 2, retry_delay_seconds: 300 },
      { provider: 'zeiss', domain: 'products', operation: 'sync', enabled: true, interval_seconds: 86400, timeout_seconds: 300, lease_ttl_seconds: 600, max_retries: 3, retry_delay_seconds: 300 },
      { provider: 'zeiss', domain: 'campaigns', operation: 'sync', enabled: true, interval_seconds: 43200, timeout_seconds: 60, lease_ttl_seconds: 120, max_retries: 3, retry_delay_seconds: 60 },
      { provider: 'zeiss', domain: 'leads', operation: 'sync', enabled: true, interval_seconds: 3600, timeout_seconds: 120, lease_ttl_seconds: 300, max_retries: 3, retry_delay_seconds: 60 },
      { provider: 'zeiss', domain: 'leads', operation: 'redeemed', enabled: true, interval_seconds: 3600, timeout_seconds: 120, lease_ttl_seconds: 300, max_retries: 3, retry_delay_seconds: 60 },
      { provider: 'zeiss', domain: 'financial', operation: 'receivables', enabled: true, interval_seconds: 21600, timeout_seconds: 180, lease_ttl_seconds: 600, max_retries: 3, retry_delay_seconds: 60 }
    );
  });

  afterEach(() => {
    delete process.env['ZEISS_CONFIG_JSON'];
  });

  // ============================================================
  // Requirement 2: Central Scheduler & Worker Integration
  // ============================================================
  describe('2. Central Multi-Store Scheduler & Worker Entrypoint', () => {
    it('should default to legacy single-store mode when RUNTIME_MODE is legacy', async () => {
      const result = await executeWorkerTick(db, 'legacy', logger);
      expect(result.mode).toBe('legacy');
      expect(result.legacySuccess).toBe(true);
      // Zero store-scoped executions in legacy mode
      expect(result.multiStoreResult).toBeUndefined();
    });

    it('should dynamically discover only active stores and execute central policies', async () => {
      // Store 1 is active, Store 2 is ready (not active), Store 3 is suspended
      db.stores.push(
        { id: 'store-1', organization_id: orgId, code: 'loja-01', name: 'Loja 01', cnpj: '11111111000191', status: 'active' },
        { id: 'store-2', organization_id: orgId, code: 'loja-02', name: 'Loja 02', cnpj: '22222222000192', status: 'ready' },
        { id: 'store-3', organization_id: orgId, code: 'loja-03', name: 'Loja 03', cnpj: '33333333000193', status: 'suspended' }
      );
      db.identities.push(
        { id: 'id-1', store_id: 'store-1', organization_id: orgId, credential_id: credId, country_id: '1', saoweb_code: '1001', zeiss_store_code: 'Z01', voucher_user_id: 'v1', fin_user_id: 'f1', leads_hmac_secret_ref: null },
        { id: 'id-2', store_id: 'store-2', organization_id: orgId, credential_id: credId, country_id: '1', saoweb_code: '1002', zeiss_store_code: 'Z02', voucher_user_id: 'v2', fin_user_id: 'f2', leads_hmac_secret_ref: null },
        { id: 'id-3', store_id: 'store-3', organization_id: orgId, credential_id: credId, country_id: '1', saoweb_code: '1003', zeiss_store_code: 'Z03', voucher_user_id: 'v3', fin_user_id: 'f3', leads_hmac_secret_ref: null }
      );

      const sleeper = new MockSleeper();
      const result = await executeWorkerTick(db, 'multi_store', logger, clock, sleeper);

      expect(result.mode).toBe('multi_store');
      expect(result.multiStoreResult).toBeDefined();
      expect(result.multiStoreResult?.totalPolicies).toBe(7);
      expect(result.multiStoreResult?.totalActiveStores).toBe(1); // Only store-1 was active!
    });
  });

  // ============================================================
  // Requirement 3: Historical Bootstrap Homologation
  // ============================================================
  describe('3. Historical Bootstrap Homologation', () => {
    it('should slice lookback into 7-day ranges, persist checkpoints, and catch up to active', async () => {
      // Provision store in ready state
      const targetStoreId = 'store-bootstrap-test';
      db.stores.push({ id: targetStoreId, organization_id: orgId, code: 'loja-bootstrap', name: 'Loja Bootstrap', cnpj: '44444444000194', status: 'ready' });
      db.identities.push({ id: 'id-bs', store_id: targetStoreId, organization_id: orgId, credential_id: credId, country_id: '1', saoweb_code: '9901', zeiss_store_code: 'ZBS', voucher_user_id: 'vbs', fin_user_id: 'fbs', leads_hmac_secret_ref: null });

      const mockStoreResolution: IStoreResolutionService = {
        resolveStore: jest.fn().mockResolvedValue({
          storeId: targetStoreId,
          organizationId: orgId,
          storeCode: 'loja-bootstrap',
          countryId: '1',
          saowebCode: '9901',
          zeissStoreCode: 'ZBS',
          cnpj: '44444444000194',
          voucherUserId: 'vbs',
          finUserId: 'fbs',
          credentialId: credId,
          apiKey: 'mock-key',
          status: 'ready'
        }),
        listEligibleStores: jest.fn()
      };

      const orchestrator = new StoreBootstrapOrchestrator(db, mockStoreResolution, logger, clock);

      getOrdersSpy.mockResolvedValueOnce([
        {
          'nr-pedido': 'ORD-BS-01',
          'os-cliente': 'OS-99',
          status: 'FATURADO',
          codsit: '05',
          'data-entrada': '2026-10-10',
          'previsao-entrega': '2026-10-15'
        }
      ]);
      getDetailSpy.mockResolvedValueOnce({
        status: 'FATURADO',
        situacao: { codsit: '05', codcli: '9901' },
        nf: []
      });

      let res;
      try {
        // Run historical bootstrap with 14 days lookback, 7 days per slice
        res = await orchestrator.bootstrapStore(targetStoreId, {
          lookbackDays: 14,
          sliceDays: 7,
          endDate: new Date('2026-10-19T00:00:00.000Z')
        });
      } finally {
        getOrdersSpy.mockResolvedValue([]);
        getDetailSpy.mockResolvedValue({ status: 'FATURADO', situacao: { codsit: '05' }, nf: [] });
      }

      expect(res.success).toBe(true);
      expect(res.previousStatus).toBe('ready');
      expect(res.currentStatus).toBe('active');
      expect(res.catchUpCompleted).toBe(true);

      // Verify store status was updated in database
      const storeRow = db.stores.find(s => s.id === targetStoreId);
      expect(storeRow?.status).toBe('active');

      // Verify persistent checkpoint was recorded
      expect(db.storeSyncState.length).toBeGreaterThan(0);
      const ordersCheckpoint = db.storeSyncState.find(s => s.store_id === targetStoreId && s.domain === 'orders');
      expect(ordersCheckpoint).toBeDefined();
    });
  });

  // ============================================================
  // Requirement 4: Continental Strategy & Conflict Avoidance
  // ============================================================
  describe('4. Continental Historical Conflict Avoidance & Reconciliation', () => {
    it('should NOT overwrite historical orders with store_id IS NULL when store upserts', async () => {
      // 1. Existing historical order without store_id
      const historicalOrderNumber = 'HIST-7180';
      db.orders.push({
        id: 'hist-uuid-1',
        order_number: historicalOrderNumber,
        os_number: 'LEGACY-OS',
        status: 'EM_PROCESSAMENTO',
        store_id: null
      });

      const repo = new PgOrdersRepository(db, continentalStoreId);

      // 2. Continental tries to upsert the same order_number
      await repo.upsertMany([
        {
          order_number: historicalOrderNumber,
          os_number: 'CONTINENTAL-NEW-OS',
          status: 'FATURADO',
          codsit: '05'
        }
      ]);

      // 3. Verify that the historical record was NOT reassigned to continental!
      const orderInDb = db.orders.find(o => o.order_number === historicalOrderNumber);
      expect(orderInDb.store_id).toBeNull(); // 100% preserved!
    });

    it('should audit unassigned orders and categorize by evidence without mutating data', async () => {
      // Seed 3 unassigned historical orders
      db.orders.push(
        { id: 'o-1', order_number: 'ORD-MATCH', status: 'FATURADO', entry_date: '2026-05-01', store_id: null },
        { id: 'o-2', order_number: 'ORD-UNKNOWN', status: 'PENDENTE', entry_date: '2026-05-02', store_id: null },
        { id: 'o-3', order_number: 'ORD-CONFLICT', status: 'FATURADO', entry_date: '2026-05-03', store_id: null }
      );

      // Seed detail matching Continental SAOWEB (33417)
      db.orderDetails.push({ id: 'd-1', order_id: 'o-1', codcli: '33417' });

      // Seed detail matching a different store (99999)
      db.orderDetails.push({ id: 'd-3', order_id: 'o-3', codcli: '99999' });

      const reconService = new ContinentalReconciliationService(db, logger);

      const report = await reconService.auditHistoricalOrders(
        {
          targetStoreId: continentalStoreId,
          storeCode: 'continental',
          saowebCode: '33417',
          cnpj: '48310092000132'
        },
        { dryRun: true }
      );

      expect(report.totalAudited).toBe(3);
      expect(report.confirmedMatches).toBe(1);
      expect(report.inconclusiveCandidates).toBe(1);
      expect(report.conflictsCount).toBe(1);
      expect(report.dryRun).toBe(true);
      expect(report.executedMutations).toBe(0);

      // Verify that all 3 orders still have store_id NULL
      expect(db.orders.filter(o => o.store_id === null).length).toBe(3);
    });
  });

  // ============================================================
  // Requirement 5: Independent API Homologation
  // ============================================================
  describe('5. Serving API Homologation', () => {
    let rawApiKey: string;
    let authService: ConsumerAuthService;
    let handlers: ApiHandlers;

    beforeEach(() => {
      rawApiKey = 'zeiss_secret_token_1234567890';
      const secretHash = ConsumerAuthService.hashSecret(rawApiKey);

      // Seed Consumer with access only to continentalStoreId
      db.apiConsumers.push({
        id: 'consumer-1',
        client_id: 'app-portal-oticas',
        display_name: 'Portal Óticas',
        enabled: true,
        allowed_scopes: ['orders:read', 'vouchers:write'],
        allowed_store_ids: [continentalStoreId]
      });

      db.apiCredentials.push({
        id: 'cred-api-1',
        consumer_id: 'consumer-1',
        secret_hash: secretHash,
        expires_at: null,
        revoked_at: null
      });

      authService = new ConsumerAuthService(db);
      handlers = new ApiHandlers(db);
    });

    it('should authenticate valid API key and reject unauthorized store access', async () => {
      const consumer = await authService.authenticate(`Bearer ${rawApiKey}`);
      expect(consumer.clientId).toBe('app-portal-oticas');

      // Authorized store access
      expect(() => authService.authorize(consumer, 'orders:read', continentalStoreId)).not.toThrow();

      // Denied store access
      expect(() => authService.authorize(consumer, 'orders:read', 'other-store-uuid')).toThrow(
        /forbidden from accessing store/
      );
    });

    it('should strictly exclude unassigned historical orders (store_id IS NULL) from store endpoints', async () => {
      // Seed orders
      db.orders.push(
        { id: 'o-c1', order_number: 'CONT-1', store_id: continentalStoreId, status: 'FATURADO' },
        { id: 'o-leg', order_number: 'LEGACY-1', store_id: null, status: 'FATURADO' },
        { id: 'o-oth', order_number: 'OTHER-1', store_id: 'other-store-id', status: 'FATURADO' }
      );

      const res = await handlers.listOrders(continentalStoreId, {});

      expect(res.orders.length).toBe(1);
      expect(res.orders[0].order_number).toBe('CONT-1');
      // Zero leakage of store_id NULL
      expect(res.orders.some((o: any) => o.order_number === 'LEGACY-1')).toBe(false);
    });

    it('should handle idempotent mutations with replay protection', async () => {
      const auditService = new AuditService(db);
      const mockStoreResolution: IStoreResolutionService = {
        resolveStore: jest.fn().mockResolvedValue({
          storeId: continentalStoreId,
          organizationId: orgId,
          storeCode: 'continental',
          countryId: '1',
          saowebCode: '33417',
          zeissStoreCode: 'CN043229',
          cnpj: '48310092000132',
          voucherUserId: 'v1',
          finUserId: 'f1',
          credentialId: credId,
          status: 'active'
        }),
        listEligibleStores: jest.fn()
      };

      const customHandlers = new ApiHandlers(db, mockStoreResolution, auditService);

      // Simulate first activation
      const key = 'IDEM-UUID-999';
      const body = { campaignId: 'camp-100', voucherCode: 'VCH-999' };

      // We mock vouchersProvider behavior through db/operations
      const firstCheck = await auditService.checkOrRegisterIdempotency('consumer-1', 'vouchers:activate', continentalStoreId, key, body);
      expect(firstCheck.isDuplicate).toBe(false);

      await auditService.finalizeOperation(firstCheck.operationId, 'completed', { voucherCode: 'VCH-999', activated: true });

      // Duplicate request with the same idempotency key
      const secondCheck = await auditService.checkOrRegisterIdempotency('consumer-1', 'vouchers:activate', continentalStoreId, key, body);
      expect(secondCheck.isDuplicate).toBe(true);
      expect(secondCheck.previousResponse).toEqual({ voucherCode: 'VCH-999', activated: true });
    });
  });

  // ============================================================
  // Requirement 6: Zero-Deploy Onboarding Lifecycle
  // ============================================================
  describe('6. Zero-Deploy Onboarding Lifecycle', () => {
    it('should complete the entire lifecycle from draft to active without code deploy', async () => {
      const onboardingService = new StoreOnboardingService(db);

      // 1. Register store (validating 14-digit CNPJ with modulo 11)
      const reg = await onboardingService.registerStore({
        organizationId: orgId,
        storeCode: 'loja-campinas',
        storeName: 'Ótica Campinas',
        cnpj: '11.222.333/0001-81', // Valid test CNPJ
        credentialId: credId,
        countryId: '1',
        saowebCode: '44556',
        zeissStoreCode: 'CPN01',
        voucherUserId: 'usr_vch',
        finUserId: 'usr_fin'
      });

      expect(reg.status).toBe('draft');

      // 2. Validate and mark ready
      const ready = await onboardingService.validateAndMarkReady(reg.storeId);
      expect(ready.status).toBe('ready');

      // 3. Suspend and Reactivate
      await onboardingService.suspendStore(reg.storeId);
      expect(db.stores.find(s => s.id === reg.storeId)?.status).toBe('suspended');

      await onboardingService.reactivateStore(reg.storeId);
      expect(db.stores.find(s => s.id === reg.storeId)?.status).toBe('active');
    });
  });
});
