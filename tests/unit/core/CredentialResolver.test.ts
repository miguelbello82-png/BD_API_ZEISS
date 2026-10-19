import { EnvRefCredentialResolver } from '../../../src/core/CredentialResolver';
import { CredentialResolutionError } from '../../../src/contracts/store';

describe('EnvRefCredentialResolver Unit Tests', () => {
  const resolver = new EnvRefCredentialResolver();
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('resolves active env_ref credential successfully', async () => {
    process.env.TEST_API_KEY = 'secret-key-123';

    const secret = await resolver.resolve({
      storageType: 'env_ref',
      secretRef: 'TEST_API_KEY',
      status: 'active',
      organizationId: 'org-uuid-1',
    });

    expect(secret).toBe('secret-key-123');
  });

  it('throws CredentialResolutionError when credential status is not active', async () => {
    process.env.TEST_API_KEY = 'secret-key-123';

    await expect(
      resolver.resolve({
        storageType: 'env_ref',
        secretRef: 'TEST_API_KEY',
        status: 'revoked',
        organizationId: 'org-uuid-1',
      })
    ).rejects.toThrow(CredentialResolutionError);

    await expect(
      resolver.resolve({
        storageType: 'env_ref',
        secretRef: 'TEST_API_KEY',
        status: 'pending',
        organizationId: 'org-uuid-1',
      })
    ).rejects.toThrow(/not active/);
  });

  it('throws CredentialResolutionError when referenced env variable is missing or empty', async () => {
    delete process.env.NON_EXISTENT_VAR;

    await expect(
      resolver.resolve({
        storageType: 'env_ref',
        secretRef: 'NON_EXISTENT_VAR',
        status: 'active',
        organizationId: 'org-uuid-1',
      })
    ).rejects.toThrow(CredentialResolutionError);

    process.env.EMPTY_VAR = '   ';
    await expect(
      resolver.resolve({
        storageType: 'env_ref',
        secretRef: 'EMPTY_VAR',
        status: 'active',
        organizationId: 'org-uuid-1',
      })
    ).rejects.toThrow(/empty/);
  });

  it('throws CredentialResolutionError for unsupported storage type', async () => {
    await expect(
      resolver.resolve({
        storageType: 'aws_secrets_manager',
        secretRef: 'arn:aws:...',
        status: 'active',
        organizationId: 'org-uuid-1',
      })
    ).rejects.toThrow(/Unsupported secret storage type/);
  });

  it('does not expose secret values in error messages', async () => {
    try {
      await resolver.resolve({
        storageType: 'unknown_type',
        secretRef: 'SUPER_SENSITIVE_REF',
        status: 'active',
        organizationId: 'org-uuid-1',
      });
      fail('Expected error');
    } catch (err: any) {
      expect(err.message).not.toContain('secret-key-123');
      expect(err.name).toBe('CredentialResolutionError');
    }
  });
});
