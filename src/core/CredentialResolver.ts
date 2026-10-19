import { CredentialResolutionError } from '../contracts/store';

export interface CredentialResolutionParams {
  storageType: string;
  secretRef: string;
  status: string;
  organizationId: string;
  storageLocation?: string | null;
}

export interface ICredentialResolver {
  resolve(params: CredentialResolutionParams): Promise<string>;
}

export interface ISecureStorageDriver {
  getSecret(secretRef: string, organizationId: string, storageLocation?: string | null): Promise<string | null>;
}

/**
 * Transitional resolver supporting env_ref for Continental and extensible
 * drivers (e.g. Vault, Secrets Manager) for new stores without redeployment.
 */
export class CompositeCredentialResolver implements ICredentialResolver {
  constructor(private vaultDriver?: ISecureStorageDriver) {}

  async resolve(params: CredentialResolutionParams): Promise<string> {
    const { storageType, secretRef, status, organizationId, storageLocation } = params;

    if (status !== 'active') {
      throw new CredentialResolutionError(`Credential status is not active (status: ${status})`);
    }

    // 1. env_ref (Transitional compatibility for Continental)
    if (storageType === 'env_ref') {
      const secret = process.env[secretRef];
      if (!secret || secret.trim().length === 0) {
        throw new CredentialResolutionError(
          `Secret reference '${secretRef}' is not defined or is empty in the environment`
        );
      }
      return secret.trim();
    }

    // 2. secure vault / secrets manager / encrypted ref (Zero-redeploy onboarding)
    if (storageType === 'vault' || storageType === 'secrets_manager' || storageType === 'encrypted_ref') {
      if (this.vaultDriver) {
        const resolved = await this.vaultDriver.getSecret(secretRef, organizationId, storageLocation);
        if (!resolved || resolved.trim().length === 0) {
          throw new CredentialResolutionError(
            `Secret '${secretRef}' could not be resolved from ${storageType} for organization ${organizationId}`
          );
        }
        return resolved.trim();
      }

      // Check for master key / in-database vault decryption fallback
      const masterKey = process.env.SECURE_STORAGE_MASTER_KEY;
      if (!masterKey) {
        throw new CredentialResolutionError(
          `Secure storage '${storageType}' requires configured driver or SECURE_STORAGE_MASTER_KEY [PENDING_EXTERNAL_CONFIG]`
        );
      }

      throw new CredentialResolutionError(
        `Secure storage provider for '${storageType}' is pending external authorization/driver attachment`
      );
    }

    throw new CredentialResolutionError(`Unsupported secret storage type: '${storageType}'`);
  }
}

/**
 * Backward compatibility alias
 */
export class EnvRefCredentialResolver extends CompositeCredentialResolver {
  constructor() {
    super();
  }
}
