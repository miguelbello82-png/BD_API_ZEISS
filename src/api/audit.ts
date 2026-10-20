// ============================================================
// API Auditing & Idempotency Service — BD_API_ZEISS Platform
// ============================================================

import { IDatabaseExecutor } from '../config/db';
import { ApiError } from './types';
import * as crypto from 'crypto';

export interface IdempotencyCheckResult {
  isDuplicate: boolean;
  operationId: string;
  status?: string;
  previousResponse?: unknown;
}

export class AuditService {
  constructor(private db: IDatabaseExecutor) {}

  /**
   * Checks or registers an idempotency key for mutative operations.
   */
  async checkOrRegisterIdempotency(
    consumerId: string,
    operationName: string,
    storeId: string,
    idempotencyKey: string,
    requestPayload: unknown
  ): Promise<IdempotencyCheckResult> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new ApiError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required for this operation');
    }

    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(requestPayload || {})).digest('hex');

    // Normalize operation name to match DB CHECK constraint ('voucher.activate' | 'voucher.generate')
    const normalizedOp = operationName.replace(':', '.');

    // Query existing operation
    const existing = await this.db.query<{
      id: string;
      status: string;
      request_hash: string;
      external_reference: string | null;
    }>(
      `SELECT id, status, request_hash, external_reference
       FROM integration.api_operations
       WHERE consumer_id = $1 AND idempotency_key = $2`,
      [consumerId, idempotencyKey]
    );

    if (existing.length > 0) {
      const op = existing[0];
      if (op.request_hash !== payloadHash) {
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was previously used with a different request payload'
        );
      }

      if (op.status === 'IN_PROGRESS' || op.status === 'in_progress' || op.status === 'PENDING') {
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'A request with this idempotency key is currently being processed'
        );
      }

      return {
        isDuplicate: true,
        operationId: op.id,
        status: op.status,
        previousResponse: op.external_reference ? JSON.parse(op.external_reference) : null
      };
    }

    // Register new operation
    const operationId = crypto.randomUUID();
    await this.db.query(
      `INSERT INTO integration.api_operations (
         id, consumer_id, operation, store_id, idempotency_key, request_hash, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'IN_PROGRESS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [operationId, consumerId, normalizedOp, storeId, idempotencyKey, payloadHash]
    );

    await this.recordEvent(operationId, 'OPERATION_STARTED', {
      operation: normalizedOp,
      storeId,
      payloadHash
    });

    return {
      isDuplicate: false,
      operationId,
      status: 'IN_PROGRESS'
    };
  }

  /**
   * Finalizes an operation status and response.
   */
  async finalizeOperation(
    operationId: string,
    status: 'completed' | 'failed' | 'SUCCEEDED' | 'FAILED_FINAL',
    responseOrError: unknown,
    errorCode?: string
  ): Promise<void> {
    const dbStatus = (status === 'completed' || status === 'SUCCEEDED') ? 'SUCCEEDED' : 'FAILED_FINAL';
    const extRef = responseOrError ? JSON.stringify(responseOrError) : null;
    await this.db.query(
      `UPDATE integration.api_operations
       SET status = $1, external_reference = $2, error_code = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [dbStatus, extRef, errorCode || null, operationId]
    );

    await this.recordEvent(operationId, dbStatus === 'SUCCEEDED' ? 'OPERATION_SUCCESS' : 'OPERATION_FAILURE', {
      status: dbStatus,
      errorCode,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Records an audit event for an operation.
   */
  async recordEvent(operationId: string, eventType: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO integration.api_operation_events (operation_id, event_type, detail, recorded_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [operationId, eventType, JSON.stringify(detail)]
      );
    } catch {
      // Audit recording should not crash main request pipeline
    }
  }

  /**
   * Logs an authenticated API request for access audit.
   */
  async logAccess(
    consumerId: string,
    method: string,
    path: string,
    storeId?: string,
    statusCode?: number
  ): Promise<void> {
    const opId = crypto.randomUUID();
    try {
      await this.db.query(
        `INSERT INTO integration.api_operations (
           id, consumer_id, operation, store_id, status, error_code, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          opId,
          consumerId,
          `${method} ${path}`,
          storeId || null,
          statusCode && statusCode < 400 ? 'success' : 'error',
          statusCode ? String(statusCode) : null
        ]
      );
    } catch {
      // Non-blocking
    }
  }
}
