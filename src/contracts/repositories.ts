// ============================================================
// Repository Contracts — BD_API_ZEISS Platform
// ============================================================
// These interfaces define the data access layer consumed by the
// Sync Engine. Concrete implementations will use PostgreSQL
// (via a future adapter), but the engine depends solely on
// these abstractions to enable isolated testing.
// ============================================================

// ----- Sync Infrastructure -----

export interface SyncPolicy {
  provider: string;
  domain: string;
  operation: string;
  enabled: boolean;
  interval_seconds: number;
  lookback_seconds: number | null;
  timeout_seconds: number;
  lease_ttl_seconds: number;
  max_retries: number;
  retry_delay_seconds: number;
  operation_config?: Record<string, unknown> | null;
}

export interface SyncState {
  provider: string;
  domain: string;
  operation: string;
  last_sync: Date | null;
  cursor_value: string | null;
}

export interface SyncLease {
  provider: string;
  domain: string;
  operation: string;
  owner_token: string;
  acquired_at: Date;
  expires_at: Date;
}

export interface ProviderHealthRecord {
  provider: string;
  domain: string;
  operation: string;
  last_success: Date | null;
  last_failure: Date | null;
  status: string | null;
}

// ----- Sync Policy Repository -----

export interface ISyncPolicyRepository {
  /** Retrieve all enabled policies for a given provider. */
  findEnabledByProvider(provider: string): Promise<SyncPolicy[]>;

  /** Retrieve all enabled policies across all providers. */
  findAllEnabled(): Promise<SyncPolicy[]>;

  /** Retrieve a specific policy by its composite key. */
  findByKey(provider: string, domain: string, operation: string): Promise<SyncPolicy | null>;
}

// ----- Sync State Repository -----

export interface ISyncStateRepository {
  /** Read the current sync state for an operation. */
  findByKey(provider: string, domain: string, operation: string): Promise<SyncState | null>;

  /** Create or update the sync state after a successful run. */
  upsert(state: SyncState): Promise<void>;
}

// ----- Sync Lease Repository -----

export interface LeaseAcquisitionResult {
  acquired: boolean;
}

export interface ISyncLeaseRepository {
  /**
   * Atomically attempt to acquire a lease.
   * Must use INSERT ... ON CONFLICT ... DO UPDATE WHERE expires_at < NOW()
   * to prevent race conditions.
   */
  tryAcquire(
    provider: string,
    domain: string,
    operation: string,
    ownerToken: string,
    leaseTtlSeconds: number,
  ): Promise<LeaseAcquisitionResult>;

  /**
   * Release a lease only if the owner_token matches.
   * A worker must never release another worker's lease.
   */
  release(
    provider: string,
    domain: string,
    operation: string,
    ownerToken: string,
  ): Promise<void>;

  /**
   * Renew an existing lease.
   * Returns true if successfully renewed, false if ownership was lost.
   */
  renew(
    provider: string,
    domain: string,
    operation: string,
    ownerToken: string,
    leaseTtlSeconds: number,
  ): Promise<boolean>;
}

// ----- Provider Health Repository -----

export interface IProviderHealthRepository {
  /** Record a successful operation run. */
  recordSuccess(provider: string, domain: string, operation: string): Promise<void>;

  /** Record a failed operation run. */
  recordFailure(provider: string, domain: string, operation: string): Promise<void>;

  /** Read current health status. */
  findByKey(provider: string, domain: string, operation: string): Promise<ProviderHealthRecord | null>;
}

// ----- Data Repositories -----

import {
  OrderRecord,
  OrderCandidate,
  OrderDetailRecord,
  TrackingCandidate,
  TrackingEventRecord,
  ProductRecord,
  CampaignRecord,
  LeadRecord,
  ReceivableRecord
} from './types';

export interface IOrdersRepository {
  /** Idempotent upsert of orders discovered via ORD-001. */
  upsertMany(orders: OrderRecord[]): Promise<void>;

  /**
   * Find orders that need initial hydration (no detail record yet).
   * Represents new orders or orders pending first detail fetch.
   */
  findOrdersWithoutDetail(): Promise<OrderCandidate[]>;

  /**
   * Find orders that might still be active.
   * The repository returns candidates; the Engine applies classifiers.
   */
  findActiveOrders(): Promise<OrderCandidate[]>;
}



export interface IOrderDetailsRepository {
  /** Idempotent upsert of order detail from ORD-002. */
  upsert(orderNumber: string, detail: OrderDetailRecord): Promise<void>;

  /** Check if a detail record exists for a given order. */
  exists(orderNumber: string): Promise<boolean>;
}

export interface ITrackingRepository {
  /** Idempotent upsert of tracking events from TRK-001. */
  upsert(orderNumber: string, nfNumber: string, trackingData: TrackingEventRecord[]): Promise<void>;

  /**
   * Find orders eligible for tracking.
   * Can be constrained by a date interval for Bootstrap slicing.
   * The repository guarantees nf_number is present.
   * The Engine applies classifiers on raw_order_status and raw_tracking_status.
   */
  findTrackingCandidates(lastOrderId?: string, lastNfNumber?: string, limit?: number): Promise<TrackingCandidate[]>;

  /** Find tracking candidates within a specific order creation date range for bootstrap */
  findTrackingCandidatesByDate(startDate: string, endDate: string): Promise<TrackingCandidate[]>;

  /** Find a specific tracking candidate by order number. */
  findTrackingCandidatesForOrder(orderNumber: string): Promise<TrackingCandidate[]>;
}

export interface IProductsRepository {
  /** Idempotent upsert of products from PRD-001. */
  upsertMany(products: ProductRecord[]): Promise<void>;
}

export interface ICampaignsRepository {
  /** Idempotent upsert of campaigns from CAM-001. */
  upsertMany(campaigns: CampaignRecord[]): Promise<void>;

  /** Return all locally known active campaign IDs for leads iteration. */
}

export interface ILeadsRepository {
  /** Idempotent upsert of leads from LEAD-001. */
  upsertMany(campaignId: string, leads: LeadRecord[]): Promise<void>;

  /** Idempotent upsert of redeemed leads from LEAD-002. */
  upsertRedeemedMany(campaignId: string, leads: LeadRecord[]): Promise<void>;
}

export interface IReceivablesRepository {
  /** Idempotent upsert of receivables from FIN-001. */
  upsertMany(receivables: ReceivableRecord[]): Promise<void>;
}
