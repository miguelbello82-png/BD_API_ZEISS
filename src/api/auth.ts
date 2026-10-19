// ============================================================
// Consumer Authentication & Authorization — BD_API_ZEISS Platform
// ============================================================

import { IDatabaseExecutor } from '../config/db';
import { AuthenticatedConsumer, ApiError } from './types';
import * as crypto from 'crypto';

interface ConsumerDbRow {
  id: string;
  client_id: string;
  display_name: string;
  enabled: boolean;
  allowed_scopes: string[];
  allowed_store_ids: string[];
  credential_id: string;
  expires_at: Date | null;
  revoked_at: Date | null;
}

export class ConsumerAuthService {
  constructor(private db: IDatabaseExecutor) {}

  /**
   * Hashes an API key string using SHA-256 to compare with secret_hash bytea in the database.
   */
  static hashSecret(secret: string): Buffer {
    return crypto.createHash('sha256').update(secret.trim()).digest();
  }

  /**
   * Authenticate request using an API key from Authorization header or X-API-Key header.
   */
  async authenticate(rawHeader: string | undefined): Promise<AuthenticatedConsumer> {
    if (!rawHeader || rawHeader.trim() === '') {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication credentials missing. Provide Authorization: Bearer <key> or X-API-Key header.');
    }

    let token = rawHeader.trim();
    if (token.toLowerCase().startsWith('bearer ')) {
      token = token.slice(7).trim();
    }

    if (!token) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Bearer token is empty');
    }

    const secretHash = ConsumerAuthService.hashSecret(token);

    const query = `
      SELECT 
        c.id, c.client_id, c.display_name, c.enabled, c.allowed_scopes, c.allowed_store_ids,
        cred.id as credential_id, cred.expires_at, cred.revoked_at
      FROM integration.api_credentials cred
      JOIN integration.api_consumers c ON c.id = cred.consumer_id
      WHERE cred.secret_hash = $1
    `;

    const rows = await this.db.query<ConsumerDbRow>(query, [secretHash]);
    if (rows.length === 0) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid API key');
    }

    const row = rows[0];

    if (!row.enabled) {
      throw new ApiError(403, 'FORBIDDEN', 'Consumer account is disabled');
    }

    if (row.revoked_at) {
      throw new ApiError(401, 'TOKEN_REVOKED', 'API credential has been revoked');
    }

    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      throw new ApiError(401, 'TOKEN_EXPIRED', 'API credential has expired');
    }

    // Async record last_used_at without blocking request
    try {
      Promise.resolve(
        this.db.query(
          'UPDATE integration.api_credentials SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1',
          [row.credential_id]
        )
      ).catch(() => {});
    } catch {
      // Non-blocking
    }

    return {
      id: row.id,
      clientId: row.client_id,
      displayName: row.display_name,
      enabled: row.enabled,
      allowedScopes: row.allowed_scopes || [],
      allowedStoreIds: row.allowed_store_ids || []
    };
  }

  /**
   * Enforces that the consumer has the necessary scope.
   */
  enforceScope(consumer: AuthenticatedConsumer, requiredScope: string): void {
    const hasScope = consumer.allowedScopes.includes('*') || consumer.allowedScopes.includes(requiredScope);
    if (!hasScope) {
      throw new ApiError(
        403,
        'INSUFFICIENT_SCOPE',
        `Consumer '${consumer.clientId}' does not possess required scope: '${requiredScope}'`
      );
    }
  }

  /**
   * Enforces strict store-level isolation.
   * Consumers can only access stores listed in allowedStoreIds, or all stores if '*' is granted.
   */
  enforceStoreAccess(consumer: AuthenticatedConsumer, targetStoreId: string): void {
    if (!targetStoreId || targetStoreId.trim() === '') {
      throw new ApiError(400, 'BAD_REQUEST', 'store_id parameter is required');
    }

    const isAuthorized = consumer.allowedStoreIds.includes('*') || consumer.allowedStoreIds.includes(targetStoreId);
    if (!isAuthorized) {
      throw new ApiError(
        403,
        'STORE_ACCESS_DENIED',
        `Consumer '${consumer.clientId}' is forbidden from accessing store '${targetStoreId}'`
      );
    }
  }

  /**
   * Combined authorization: verifies both scope and store authorization.
   */
  authorize(consumer: AuthenticatedConsumer, requiredScope: string, targetStoreId?: string): void {
    this.enforceScope(consumer, requiredScope);
    if (targetStoreId) {
      this.enforceStoreAccess(consumer, targetStoreId);
    }
  }
}
