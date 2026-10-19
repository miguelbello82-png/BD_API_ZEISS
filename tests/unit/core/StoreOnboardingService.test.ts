import { StoreOnboardingService, StoreRegistrationInput } from '../../../src/core/StoreOnboardingService';
import { IDatabaseExecutor } from '../../../src/config/db';
import { StoreValidationError, StoreNotFoundError, StoreZeissContext } from '../../../src/contracts/store';

describe('StoreOnboardingService (Zero-Deploy Onboarding & Lifecycle)', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let mockClient: jest.Mocked<IDatabaseExecutor>;
  let service: StoreOnboardingService;

  const validOrgId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const validCredId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  const validCnpj = '11.222.333/0001-81'; // Valid Brazilian CNPJ

  const sampleInput: StoreRegistrationInput = {
    organizationId: validOrgId,
    storeCode: 'store-shopping-center',
    storeName: 'ZEISS Vision Center Shopping',
    cnpj: validCnpj,
    credentialId: validCredId,
    countryId: '1',
    saowebCode: 'SAO9999',
    zeissStoreCode: 'CN099999',
    voucherUserId: 'USR_VOUCHER_1',
    finUserId: 'USR_FIN_1',
  };

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      transaction: jest.fn(),
    };

    mockDb = {
      query: jest.fn(),
      transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(mockClient);
      }),
    };

    service = new StoreOnboardingService(mockDb);
  });

  it('should reject registration when CNPJ is invalid (modulo 11 check)', async () => {
    const invalidInput = { ...sampleInput, cnpj: '11.222.333/0001-00' };

    await expect(service.registerStore(invalidInput)).rejects.toThrow(StoreValidationError);
  });

  it('should reject registration when storeCode format is invalid', async () => {
    const invalidInput = { ...sampleInput, storeCode: 'STORE_INVALID!' };

    await expect(service.registerStore(invalidInput)).rejects.toThrow(StoreValidationError);
  });

  it('should reject registration when organization does not exist', async () => {
    mockClient.query.mockResolvedValueOnce([]); // Org not found

    await expect(service.registerStore(sampleInput)).rejects.toThrow('Organization');
  });

  it('should reject registration when credential belongs to a different organization', async () => {
    mockClient.query
      .mockResolvedValueOnce([{ id: validOrgId, status: 'active' }]) // Org exists
      .mockResolvedValueOnce([{ id: validCredId, organization_id: 'other-org-uuid', status: 'active' }]); // Credential mismatch

    await expect(service.registerStore(sampleInput)).rejects.toThrow('Credential does not belong to the target organization');
  });

  it('should successfully register store in draft status without redeploy', async () => {
    mockClient.query
      .mockResolvedValueOnce([{ id: validOrgId, status: 'active' }]) // Org exists
      .mockResolvedValueOnce([{ id: validCredId, organization_id: validOrgId, status: 'active' }]) // Credential matches
      .mockResolvedValueOnce([]) // Store insert
      .mockResolvedValueOnce([]); // Identity insert

    const result = await service.registerStore(sampleInput);

    expect(result.status).toBe('draft');
    expect(result.storeCode).toBe('store-shopping-center');
    expect(result.storeId).toBeDefined();

    // Verify 4 transactional queries were executed
    expect(mockClient.query).toHaveBeenCalledTimes(4);
  });

  it('should transition store from draft -> validating -> ready upon successful credential resolution', async () => {
    const storeId = 'store-uuid-123';
    const mockResolutionService = {
      resolveStore: jest.fn().mockResolvedValue({
        storeId,
        storeCode: 'store-shopping-center',
        status: 'ready',
      } as unknown as StoreZeissContext),
      listEligibleStores: jest.fn(),
      clearCache: jest.fn(),
    };

    const serviceWithResolver = new StoreOnboardingService(mockDb, mockResolutionService);

    mockDb.query
      .mockResolvedValueOnce([{ id: storeId, code: 'store-shopping-center', status: 'draft' }]) // Select store
      .mockResolvedValueOnce([]) // Update to validating
      .mockResolvedValueOnce([]); // Update to ready

    const result = await serviceWithResolver.validateAndMarkReady(storeId);

    expect(result.status).toBe('ready');
    expect(mockResolutionService.resolveStore).toHaveBeenCalledWith(storeId);
  });

  it('should transition store to error status if credential validation fails', async () => {
    const storeId = 'store-uuid-123';
    const mockResolutionService = {
      resolveStore: jest.fn().mockRejectedValue(new Error('Invalid ZEISS API key for unit CN099999')),
      listEligibleStores: jest.fn(),
      clearCache: jest.fn(),
    };

    const serviceWithResolver = new StoreOnboardingService(mockDb, mockResolutionService);

    mockDb.query
      .mockResolvedValueOnce([{ id: storeId, code: 'store-shopping-center', status: 'draft' }]) // Select store
      .mockResolvedValueOnce([]) // Update to validating
      .mockResolvedValueOnce([]); // Update to error

    await expect(serviceWithResolver.validateAndMarkReady(storeId)).rejects.toThrow(StoreValidationError);
    // Verifies store was marked as 'error'
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE core.stores SET status = $1'),
      ['error', storeId]
    );
  });

  it('should suspend store when requested', async () => {
    const storeId = 'store-uuid-123';
    mockDb.query
      .mockResolvedValueOnce([{ id: storeId, code: 'store-1' }]) // Select store
      .mockResolvedValueOnce([]); // Update status to suspended

    await service.suspendStore(storeId);

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE core.stores SET status = $1'),
      ['suspended', storeId]
    );
  });

  it('should reactivate store when requested', async () => {
    const storeId = 'store-uuid-123';
    mockDb.query
      .mockResolvedValueOnce([{ id: storeId, code: 'store-1', status: 'suspended' }]) // Select store
      .mockResolvedValueOnce([]); // Update status to active

    await service.reactivateStore(storeId);

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE core.stores SET status = $1'),
      ['active', storeId]
    );
  });
});
