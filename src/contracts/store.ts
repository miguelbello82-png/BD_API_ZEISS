// ============================================================
// Multi-Store Contracts — BD_API_ZEISS Platform
// ============================================================

export type StoreStatus =
  | 'draft'
  | 'validating'
  | 'ready'
  | 'bootstrapping'
  | 'catching_up'
  | 'active'
  | 'suspended'
  | 'error';

export interface StoreZeissContext {
  readonly storeId: string;             // Immutable internal UUID
  readonly organizationId: string;      // Organization UUID
  readonly storeCode: string;           // Friendly unique slug (e.g. 'continental')
  readonly orgCode: string;             // Organization slug (e.g. 'continental-group')
  readonly cnpj: string;                // Validated 14-digit CNPJ
  readonly status: StoreStatus;         // Lifecycle status
  readonly saowebCode: string;          // ZEISS codcli / SAOWEB code
  readonly zeissStoreCode: string;      // ZEISS store identifier (e.g. 'CN043229')
  readonly countryId: string;           // Country ID (e.g. '1')
  readonly voucherUserId: string;       // User ID for voucher operations
  readonly finUserId: string;           // User ID for financial operations
  readonly apiKey: string;              // Resolved authorized API Key
  readonly leadsHmacSecret?: string;    // Resolved leads HMAC secret
  readonly ordersBaseUrl?: string;      // Endpoint base URLs
  readonly trackingBaseUrl?: string;
  readonly campaignsBaseUrl?: string;
  readonly financialBaseUrl?: string;
  readonly servicesBaseUrl?: string;
}

export class StoreNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Store not found for identifier: ${identifier}`);
    this.name = 'StoreNotFoundError';
  }
}

export class StoreSuspendedError extends Error {
  constructor(storeCode: string, storeId: string) {
    super(`Store '${storeCode}' (${storeId}) is suspended and not eligible for execution`);
    this.name = 'StoreSuspendedError';
  }
}

export class StoreValidationError extends Error {
  constructor(message: string, public errors: string[] = []) {
    super(`Store validation error: ${message}`);
    this.name = 'StoreValidationError';
  }
}

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(`Credential resolution error: ${message}`);
    this.name = 'CredentialResolutionError';
  }
}

export class OrganizationMismatchError extends Error {
  constructor(message: string) {
    super(`Organization mismatch error: ${message}`);
    this.name = 'OrganizationMismatchError';
  }
}
