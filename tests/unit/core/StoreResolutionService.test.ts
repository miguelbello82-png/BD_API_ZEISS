import { PgStoreResolutionService } from '../../../src/core/StoreResolutionService';
import { IDatabaseExecutor } from '../../../src/config/db';
import { ICredentialResolver } from '../../../src/core/CredentialResolver';
import {
  StoreNotFoundError,
  StoreSuspendedError,
  OrganizationMismatchError
} from '../../../src/contracts/store';

describe('PgStoreResolutionService Unit Tests', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let mockResolver: jest.Mocked<ICredentialResolver>;

  const continentalRow = {
    store_id: '3cdde1d2-4461-475f-8faf-418bbb3790fd',
    store_code: 'continental',
    store_status: 'ready',
    cnpj: '48310092000132',
    organization_id: 'org-uuid-1',
    org_code: 'continental-group',
    saoweb_code: '33417',
    zeiss_store_code: 'CN043229',
    country_id: '1',
    voucher_user_id: '42',
    fin_user_id: '0',
    leads_hmac_secret_ref: 'TEST_HMAC_SECRET',
    secret_storage_type: 'env_ref',
    secret_ref: 'ZEISS_API_KEY',
    cred_status: 'active',
    cred_org_id: 'org-uuid-1',
    identity_org_id: 'org-uuid-1',
  };

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
      transaction: jest.fn(),
    } as any;

    mockResolver = {
      resolve: jest.fn().mockResolvedValue('resolved-zeiss-api-key'),
    };
  });

  it('resolves store by code successfully', async () => {
    mockDb.query.mockResolvedValueOnce([continentalRow]);

    const service = new PgStoreResolutionService(mockDb, mockResolver);
    const context = await service.resolveStore('continental');

    expect(context.storeId).toBe('3cdde1d2-4461-475f-8faf-418bbb3790fd');
    expect(context.storeCode).toBe('continental');
    expect(context.cnpj).toBe('48310092000132');
    expect(context.saowebCode).toBe('33417');
    expect(context.zeissStoreCode).toBe('CN043229');
    expect(context.countryId).toBe('1');
    expect(context.voucherUserId).toBe('42');
    expect(context.finUserId).toBe('0');
    expect(context.apiKey).toBe('resolved-zeiss-api-key');

    expect(mockResolver.resolve).toHaveBeenCalledWith({
      storageType: 'env_ref',
      secretRef: 'ZEISS_API_KEY',
      status: 'active',
      organizationId: 'org-uuid-1',
    });
  });

  it('resolves store by UUID successfully', async () => {
    mockDb.query.mockResolvedValueOnce([continentalRow]);

    const service = new PgStoreResolutionService(mockDb, mockResolver);
    const context = await service.resolveStore('3cdde1d2-4461-475f-8faf-418bbb3790fd');

    expect(context.storeId).toBe('3cdde1d2-4461-475f-8faf-418bbb3790fd');
    expect(context.storeCode).toBe('continental');
  });

  it('throws StoreNotFoundError when store does not exist', async () => {
    mockDb.query.mockResolvedValueOnce([]);

    const service = new PgStoreResolutionService(mockDb, mockResolver);
    await expect(service.resolveStore('non-existent-store')).rejects.toThrow(StoreNotFoundError);
  });

  it('throws StoreSuspendedError when store status is suspended', async () => {
    mockDb.query.mockResolvedValueOnce([{ ...continentalRow, store_status: 'suspended' }]);

    const service = new PgStoreResolutionService(mockDb, mockResolver);
    await expect(service.resolveStore('continental')).rejects.toThrow(StoreSuspendedError);
  });

  it('throws OrganizationMismatchError when organization ID is mismatched', async () => {
    mockDb.query.mockResolvedValueOnce([{ ...continentalRow, cred_org_id: 'org-uuid-diff' }]);

    const service = new PgStoreResolutionService(mockDb, mockResolver);
    await expect(service.resolveStore('continental')).rejects.toThrow(OrganizationMismatchError);
  });

  it('lists eligible stores filtering by ready and active statuses', async () => {
    mockDb.query.mockResolvedValueOnce([
      continentalRow,
      { ...continentalRow, store_id: 'store-uuid-2', store_code: 'store-2', store_status: 'active' }
    ]);

    const service = new PgStoreResolutionService(mockDb, mockResolver);
    const eligible = await service.listEligibleStores();

    expect(eligible.length).toBe(2);
    expect(eligible[0].storeCode).toBe('continental');
    expect(eligible[1].storeCode).toBe('store-2');
  });
});
