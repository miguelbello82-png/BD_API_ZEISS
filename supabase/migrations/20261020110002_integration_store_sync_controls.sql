-- ==============================================================================
-- BD_API_ZEISS — Migration: 20261020110002_integration_store_sync_controls.sql
-- Fase: ML-002B (Isolamento Operacional Multi-Loja)
-- Objetivo: Criar tabelas especializadas multi-loja de controle de sincronização,
--           preservando 100% da integridade e comportamento do worker atual
--           que utiliza as tabelas legadas integration.sync_*.
-- Idempotente e reversível.
-- ==============================================================================

-- 1. integration.store_sync_state
CREATE TABLE IF NOT EXISTS integration.store_sync_state (
    store_id UUID NOT NULL REFERENCES core.stores(id) ON DELETE RESTRICT,
    provider VARCHAR(50) NOT NULL,
    domain VARCHAR(50) NOT NULL,
    operation VARCHAR(50) NOT NULL,
    last_sync TIMESTAMPTZ NULL,
    cursor_value VARCHAR NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_integration_store_sync_state PRIMARY KEY (store_id, provider, domain, operation)
);
CREATE INDEX IF NOT EXISTS idx_integration_store_sync_state_lookup 
    ON integration.store_sync_state(store_id, provider, domain, operation);

-- 2. integration.store_sync_policies
CREATE TABLE IF NOT EXISTS integration.store_sync_policies (
    store_id UUID NOT NULL REFERENCES core.stores(id) ON DELETE RESTRICT,
    provider VARCHAR(50) NOT NULL,
    domain VARCHAR(50) NOT NULL,
    operation VARCHAR(50) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    interval_seconds INT NOT NULL,
    lookback_seconds INT NULL,
    timeout_seconds INT NOT NULL,
    lease_ttl_seconds INT NOT NULL,
    max_retries INT NOT NULL DEFAULT 0,
    retry_delay_seconds INT NOT NULL DEFAULT 0,
    operation_config JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_integration_store_sync_policies PRIMARY KEY (store_id, provider, domain, operation),
    CONSTRAINT chk_store_policy_interval CHECK (interval_seconds > 0),
    CONSTRAINT chk_store_policy_timeout CHECK (timeout_seconds > 0),
    CONSTRAINT chk_store_policy_lease CHECK (lease_ttl_seconds > 0),
    CONSTRAINT chk_store_policy_retries CHECK (max_retries >= 0),
    CONSTRAINT chk_store_policy_delay CHECK (retry_delay_seconds >= 0)
);
CREATE INDEX IF NOT EXISTS idx_integration_store_sync_policies_enabled 
    ON integration.store_sync_policies(store_id, enabled);

-- 3. integration.store_sync_leases
CREATE TABLE IF NOT EXISTS integration.store_sync_leases (
    store_id UUID NOT NULL REFERENCES core.stores(id) ON DELETE RESTRICT,
    provider VARCHAR(50) NOT NULL,
    domain VARCHAR(50) NOT NULL,
    operation VARCHAR(50) NOT NULL,
    owner_token UUID NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_integration_store_sync_leases PRIMARY KEY (store_id, provider, domain, operation)
);
CREATE INDEX IF NOT EXISTS idx_integration_store_sync_leases_expires 
    ON integration.store_sync_leases(store_id, expires_at);

-- 4. integration.store_provider_health
CREATE TABLE IF NOT EXISTS integration.store_provider_health (
    store_id UUID NOT NULL REFERENCES core.stores(id) ON DELETE RESTRICT,
    provider VARCHAR(50) NOT NULL,
    domain VARCHAR(50) NOT NULL,
    operation VARCHAR(50) NOT NULL,
    status VARCHAR(50) NULL,
    last_success TIMESTAMPTZ NULL,
    last_failure TIMESTAMPTZ NULL,
    consecutive_failures INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_integration_store_provider_health PRIMARY KEY (store_id, provider, domain, operation)
);
CREATE INDEX IF NOT EXISTS idx_integration_store_health_lookup 
    ON integration.store_provider_health(store_id, provider, status);

-- 5. Habilitar RLS
ALTER TABLE integration.store_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.store_sync_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.store_sync_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.store_provider_health ENABLE ROW LEVEL SECURITY;

-- 6. Conceder Permissões
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bd_api_zeiss_worker') THEN
        EXECUTE 'GRANT ALL ON integration.store_sync_state TO bd_api_zeiss_worker';
        EXECUTE 'GRANT ALL ON integration.store_sync_policies TO bd_api_zeiss_worker';
        EXECUTE 'GRANT ALL ON integration.store_sync_leases TO bd_api_zeiss_worker';
        EXECUTE 'GRANT ALL ON integration.store_provider_health TO bd_api_zeiss_worker';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT ALL ON integration.store_sync_state TO service_role';
        EXECUTE 'GRANT ALL ON integration.store_sync_policies TO service_role';
        EXECUTE 'GRANT ALL ON integration.store_sync_leases TO service_role';
        EXECUTE 'GRANT ALL ON integration.store_provider_health TO service_role';
    END IF;
END $$;

-- 7. Políticas de RLS
DO $$
BEGIN
    DROP POLICY IF EXISTS worker_store_sync_state_all ON integration.store_sync_state;
    DROP POLICY IF EXISTS worker_store_sync_policies_all ON integration.store_sync_policies;
    DROP POLICY IF EXISTS worker_store_sync_leases_all ON integration.store_sync_leases;
    DROP POLICY IF EXISTS worker_store_provider_health_all ON integration.store_provider_health;

    DROP POLICY IF EXISTS service_role_store_sync_state_all ON integration.store_sync_state;
    DROP POLICY IF EXISTS service_role_store_sync_policies_all ON integration.store_sync_policies;
    DROP POLICY IF EXISTS service_role_store_sync_leases_all ON integration.store_sync_leases;
    DROP POLICY IF EXISTS service_role_store_provider_health_all ON integration.store_provider_health;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bd_api_zeiss_worker') THEN
        CREATE POLICY worker_store_sync_state_all ON integration.store_sync_state FOR ALL TO bd_api_zeiss_worker USING (true) WITH CHECK (true);
        CREATE POLICY worker_store_sync_policies_all ON integration.store_sync_policies FOR ALL TO bd_api_zeiss_worker USING (true) WITH CHECK (true);
        CREATE POLICY worker_store_sync_leases_all ON integration.store_sync_leases FOR ALL TO bd_api_zeiss_worker USING (true) WITH CHECK (true);
        CREATE POLICY worker_store_provider_health_all ON integration.store_provider_health FOR ALL TO bd_api_zeiss_worker USING (true) WITH CHECK (true);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE POLICY service_role_store_sync_state_all ON integration.store_sync_state FOR ALL TO service_role USING (true) WITH CHECK (true);
        CREATE POLICY service_role_store_sync_policies_all ON integration.store_sync_policies FOR ALL TO service_role USING (true) WITH CHECK (true);
        CREATE POLICY service_role_store_sync_leases_all ON integration.store_sync_leases FOR ALL TO service_role USING (true) WITH CHECK (true);
        CREATE POLICY service_role_store_provider_health_all ON integration.store_provider_health FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;
