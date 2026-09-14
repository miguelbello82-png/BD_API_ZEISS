-- 0010_sync_policies.sql (PLATFORM-NATIVE)

CREATE TABLE integration.sync_policies (
    provider VARCHAR(100) NOT NULL,
    domain VARCHAR(100) NOT NULL,
    operation VARCHAR(100) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    interval_seconds INTEGER NOT NULL,
    lookback_seconds INTEGER NULL,
    timeout_seconds INTEGER NOT NULL,
    lease_ttl_seconds INTEGER NOT NULL,
    max_retries INTEGER NOT NULL,
    retry_delay_seconds INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT sync_policies_pkey PRIMARY KEY (provider, domain, operation),
    CONSTRAINT check_interval_positive CHECK (interval_seconds > 0),
    CONSTRAINT check_lookback_positive CHECK (lookback_seconds IS NULL OR lookback_seconds > 0),
    CONSTRAINT check_timeout_positive CHECK (timeout_seconds > 0),
    CONSTRAINT check_lease_ttl_positive CHECK (lease_ttl_seconds > 0),
    CONSTRAINT check_max_retries_non_negative CHECK (max_retries >= 0),
    CONSTRAINT check_retry_delay_non_negative CHECK (retry_delay_seconds >= 0)
);

ALTER TABLE integration.sync_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE integration.sync_policies FROM PUBLIC, anon, authenticated, service_role;
