// ============================================================
// Serving API Contracts & Types — BD_API_ZEISS Platform
// ============================================================

export interface AuthenticatedConsumer {
  id: string;                    // UUID
  clientId: string;              // Unique identifier (e.g. 'pos-app-1')
  displayName: string;           // Human readable name
  enabled: boolean;
  allowedScopes: string[];       // e.g. ['orders:read', 'tracking:read', 'campaigns:read', 'vouchers:write']
  allowedStoreIds: string[];     // UUIDs of allowed stores, or ['*'] for all stores
}

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'STORE_NOT_FOUND'
  | 'STORE_ACCESS_DENIED'
  | 'INSUFFICIENT_SCOPE'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'MUTATION_DISABLED'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface StandardApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
  meta?: {
    timestamp: string;
    requestId?: string;
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}

export interface VoucherGenerateRequestPayload {
  campaignId: string;
  name: string;
  email: string;
  phone?: string;
  cpf?: string;
  zipcode?: string;
  city?: string;
  state?: string;
  source?: number;
  sendmail?: 'S' | 'N';
  termssn?: 'S' | 'N';
  comunicadossn?: 'S' | 'N';
}

