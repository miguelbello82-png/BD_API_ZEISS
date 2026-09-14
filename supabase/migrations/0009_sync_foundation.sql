-- 0009_sync_foundation.sql (PLATFORM-NATIVE)

-- A. integration.sync_leases
CREATE TABLE integration.sync_leases (
    provider VARCHAR(100) NOT NULL,
    domain VARCHAR(100) NOT NULL,
    operation VARCHAR(100) NOT NULL,
    owner_token UUID NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (provider, domain, operation)
);
ALTER TABLE integration.sync_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE integration.sync_leases FROM PUBLIC, anon, authenticated, service_role;

-- B. integration.sync_state
ALTER TABLE integration.sync_state DROP CONSTRAINT sync_state_pkey;
ALTER TABLE integration.sync_state 
    ADD COLUMN provider VARCHAR(100) NOT NULL,
    ADD COLUMN operation VARCHAR(100) NOT NULL;
ALTER TABLE integration.sync_state ADD CONSTRAINT sync_state_pkey PRIMARY KEY (provider, domain, operation);

-- C. integration.provider_health
ALTER TABLE integration.provider_health DROP CONSTRAINT provider_health_pkey;
ALTER TABLE integration.provider_health 
    ADD COLUMN domain VARCHAR(100) NOT NULL;
ALTER TABLE integration.provider_health ADD CONSTRAINT provider_health_pkey PRIMARY KEY (provider, domain);

-- D. zeiss.order_details
ALTER TABLE zeiss.order_details ADD CONSTRAINT order_details_order_id_key UNIQUE(order_id);
