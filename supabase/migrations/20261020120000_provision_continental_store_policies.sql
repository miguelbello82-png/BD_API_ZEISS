-- Migration: 20261020120000_provision_continental_store_policies.sql
-- Description: Provision initial multi-store sync policies for Continental store (disabled by default)

INSERT INTO integration.store_sync_policies (
    store_id, provider, domain, operation, enabled, interval_seconds, lookback_seconds,
    timeout_seconds, lease_ttl_seconds, max_retries, retry_delay_seconds, operation_config
)
SELECT
    '3cdde1d2-4461-475f-8faf-418bbb3790fd'::uuid,
    provider,
    domain,
    operation,
    false, -- Disabled by default to prevent automatic execution in production
    interval_seconds,
    lookback_seconds,
    timeout_seconds,
    lease_ttl_seconds,
    max_retries,
    retry_delay_seconds,
    operation_config
FROM integration.sync_policies
ON CONFLICT (store_id, provider, domain, operation) DO NOTHING;
