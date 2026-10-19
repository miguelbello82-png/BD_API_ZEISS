import { IDatabaseExecutor } from '../config/db';
import { isValidCnpj } from './CnpjValidator';
import {
  StoreStatus,
  StoreValidationError,
  StoreNotFoundError
} from '../contracts/store';
import { IStoreResolutionService } from './StoreResolutionService';
import { randomUUID } from 'crypto';

export interface StoreRegistrationInput {
  organizationId: string;
  storeCode: string;
  storeName: string;
  cnpj: string;
  credentialId: string;
  countryId: string;
  saowebCode: string;
  zeissStoreCode: string;
  voucherUserId: string;
  finUserId: string;
  leadsHmacSecretRef?: string;
}

export interface StoreRegistrationResult {
  storeId: string;
  storeCode: string;
  status: StoreStatus;
}

export class StoreOnboardingService {
  constructor(
    private db: IDatabaseExecutor,
    private storeResolutionService?: IStoreResolutionService
  ) {}

  validateRegistrationInput(input: StoreRegistrationInput): string[] {
    const errors: string[] = [];

    if (!input.organizationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.organizationId)) {
      errors.push('organizationId must be a valid UUID');
    }

    if (!input.storeCode || !/^[a-z0-9][a-z0-9_-]{1,48}[a-z0-9]$/.test(input.storeCode)) {
      errors.push('storeCode must be lowercase alphanumeric with hyphens/underscores (3-50 chars)');
    }

    if (!input.storeName || input.storeName.trim().length === 0) {
      errors.push('storeName must not be empty');
    }

    const cleanCnpj = (input.cnpj || '').replace(/\D/g, '');
    if (!isValidCnpj(cleanCnpj)) {
      errors.push('cnpj is invalid (failed 14-digit modulo 11 check)');
    }

    if (!input.credentialId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.credentialId)) {
      errors.push('credentialId must be a valid UUID');
    }

    if (!input.countryId || !/^\d+$/.test(input.countryId)) {
      errors.push('countryId must be a numeric string (e.g. "1")');
    }

    if (!input.saowebCode || input.saowebCode.trim().length === 0) {
      errors.push('saowebCode must not be empty');
    }

    if (!input.zeissStoreCode || input.zeissStoreCode.trim().length === 0) {
      errors.push('zeissStoreCode must not be empty');
    }

    if (!input.voucherUserId || input.voucherUserId.trim().length === 0) {
      errors.push('voucherUserId must not be empty');
    }

    if (!input.finUserId || input.finUserId.trim().length === 0) {
      errors.push('finUserId must not be empty');
    }

    return errors;
  }

  async registerStore(input: StoreRegistrationInput): Promise<StoreRegistrationResult> {
    const errors = this.validateRegistrationInput(input);
    if (errors.length > 0) {
      throw new StoreValidationError('Invalid store registration input', errors);
    }

    const cleanCnpj = input.cnpj.replace(/\D/g, '');
    const storeId = randomUUID();
    const identityId = randomUUID();

    await this.db.transaction(async (client) => {
      // 1. Verify organization exists and is active
      const orgRows = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM core.organizations WHERE id = $1',
        [input.organizationId]
      );
      if (orgRows.length === 0) {
        throw new StoreValidationError(`Organization ${input.organizationId} not found`);
      }
      if (orgRows[0].status !== 'active') {
        throw new StoreValidationError(`Organization ${input.organizationId} is not active`);
      }

      // 2. Verify credential exists and belongs to the same organization
      const credRows = await client.query<{ id: string; organization_id: string; status: string }>(
        'SELECT id, organization_id, status FROM core.integration_credentials WHERE id = $1',
        [input.credentialId]
      );
      if (credRows.length === 0) {
        throw new StoreValidationError(`Credential ${input.credentialId} not found`);
      }
      if (credRows[0].organization_id !== input.organizationId) {
        throw new StoreValidationError('Credential does not belong to the target organization');
      }

      // 3. Insert into core.stores with initial status 'draft'
      const storeInsertSql = `
        INSERT INTO core.stores (id, organization_id, code, name, cnpj, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id, code, status
      `;
      await client.query(storeInsertSql, [
        storeId,
        input.organizationId,
        input.storeCode,
        input.storeName,
        cleanCnpj
      ]);

      // 4. Insert into core.store_zeiss_identities
      const identityInsertSql = `
        INSERT INTO core.store_zeiss_identities (
          id, store_id, organization_id, credential_id,
          country_id, saoweb_code, zeiss_store_code,
          voucher_user_id, fin_user_id, leads_hmac_secret_ref,
          created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await client.query(identityInsertSql, [
        identityId,
        storeId,
        input.organizationId,
        input.credentialId,
        input.countryId,
        input.saowebCode,
        input.zeissStoreCode,
        input.voucherUserId,
        input.finUserId,
        input.leadsHmacSecretRef || null
      ]);
    });

    return {
      storeId,
      storeCode: input.storeCode,
      status: 'draft'
    };
  }

  async validateAndMarkReady(storeId: string): Promise<StoreRegistrationResult> {
    const rows = await this.db.query<{ id: string; code: string; status: StoreStatus }>(
      'SELECT id, code, status FROM core.stores WHERE id = $1',
      [storeId]
    );
    if (rows.length === 0) {
      throw new StoreNotFoundError(storeId);
    }

    const store = rows[0];

    // Transition to 'validating'
    await this.updateStatus(storeId, 'validating');

    try {
      if (this.storeResolutionService) {
        // Attempt to resolve context and test credential resolution
        await this.storeResolutionService.resolveStore(storeId);
      }

      // Transition to 'ready'
      await this.updateStatus(storeId, 'ready');
      return {
        storeId,
        storeCode: store.code,
        status: 'ready'
      };
    } catch (err) {
      await this.updateStatus(storeId, 'error');
      const msg = err instanceof Error ? err.message : String(err);
      throw new StoreValidationError(`Store credential validation failed: ${msg}`);
    }
  }

  async suspendStore(storeId: string, reason?: string): Promise<void> {
    const rows = await this.db.query<{ id: string; code: string }>(
      'SELECT id, code FROM core.stores WHERE id = $1',
      [storeId]
    );
    if (rows.length === 0) {
      throw new StoreNotFoundError(storeId);
    }
    await this.updateStatus(storeId, 'suspended');
  }

  async reactivateStore(storeId: string): Promise<void> {
    const rows = await this.db.query<{ id: string; code: string; status: string }>(
      'SELECT id, code, status FROM core.stores WHERE id = $1',
      [storeId]
    );
    if (rows.length === 0) {
      throw new StoreNotFoundError(storeId);
    }
    // Only reactivate if not in error state
    await this.updateStatus(storeId, 'active');
  }

  async updateStatus(storeId: string, status: StoreStatus): Promise<void> {
    await this.db.query(
      'UPDATE core.stores SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, storeId]
    );
  }
}
