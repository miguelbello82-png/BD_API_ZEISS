-- ==============================================================================
-- BD_API_ZEISS — Migration: 20261020100001_core_stores_and_identities.sql
-- Fase: ML-002A (Fundação Multi-Loja)
-- Objetivo: Criação das tabelas core.stores e core.store_zeiss_identities com FKs compostas.
-- Idempotente e reversível.
-- ==============================================================================

-- 1. Tabela core.stores
CREATE TABLE IF NOT EXISTS core.stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES core.organizations(id) ON DELETE RESTRICT,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    cnpj VARCHAR(14) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_core_stores_code UNIQUE (code),
    CONSTRAINT uq_core_stores_cnpj UNIQUE (cnpj),
    CONSTRAINT uq_core_stores_id_org UNIQUE (id, organization_id),
    CONSTRAINT chk_core_stores_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,48}[a-z0-9]$'),
    CONSTRAINT chk_core_stores_cnpj_digits CHECK (cnpj ~ '^[0-9]{14}$'),
    CONSTRAINT chk_core_stores_status CHECK (status IN ('draft', 'validating', 'ready', 'active', 'suspended', 'error'))
);

-- 2. Tabela core.store_zeiss_identities
-- Utiliza FK composta (credential_id, organization_id) e (store_id, organization_id)
-- para garantir matematicamente que uma loja jamais seja vinculada a credencial de outra organização!
CREATE TABLE IF NOT EXISTS core.store_zeiss_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    credential_id UUID NOT NULL,
    country_id VARCHAR(10) NOT NULL DEFAULT '1',
    saoweb_code VARCHAR(50) NOT NULL,
    zeiss_store_code VARCHAR(50) NOT NULL,
    voucher_user_id VARCHAR(50) NOT NULL,
    fin_user_id VARCHAR(50) NOT NULL DEFAULT '0',
    leads_hmac_secret_ref VARCHAR(255) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_core_store_identities_store_id UNIQUE (store_id),
    CONSTRAINT uq_core_store_identities_zeiss_code UNIQUE (zeiss_store_code),
    CONSTRAINT fk_core_identities_store_org FOREIGN KEY (store_id, organization_id)
        REFERENCES core.stores(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_core_identities_credential_org FOREIGN KEY (credential_id, organization_id)
        REFERENCES core.integration_credentials(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT chk_core_zeiss_country_id CHECK (country_id ~ '^[0-9]{1,4}$'),
    CONSTRAINT chk_core_zeiss_saoweb CHECK (saoweb_code ~ '^[0-9]{1,10}$'),
    CONSTRAINT chk_core_zeiss_store_code CHECK (zeiss_store_code ~ '^[A-Za-z0-9_-]{2,50}$'),
    CONSTRAINT chk_core_zeiss_voucher_user CHECK (voucher_user_id ~ '^[0-9]{1,10}$'),
    CONSTRAINT chk_core_zeiss_fin_user CHECK (fin_user_id ~ '^[0-9]{1,10}$')
);

-- Índices de Performance
CREATE INDEX IF NOT EXISTS idx_core_stores_org ON core.stores(organization_id);
CREATE INDEX IF NOT EXISTS idx_core_stores_status ON core.stores(status);
CREATE INDEX IF NOT EXISTS idx_core_identities_credential ON core.store_zeiss_identities(credential_id);
CREATE INDEX IF NOT EXISTS idx_core_identities_org ON core.store_zeiss_identities(organization_id);

-- 3. Habilitar RLS
ALTER TABLE core.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.store_zeiss_identities ENABLE ROW LEVEL SECURITY;

-- 4. Conceder Permissões
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bd_api_zeiss_worker') THEN
        EXECUTE 'GRANT SELECT ON core.stores TO bd_api_zeiss_worker';
        EXECUTE 'GRANT SELECT ON core.store_zeiss_identities TO bd_api_zeiss_worker';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT ALL ON core.stores TO service_role';
        EXECUTE 'GRANT ALL ON core.store_zeiss_identities TO service_role';
    END IF;
END $$;

-- 5. Políticas de RLS
DO $$
BEGIN
    DROP POLICY IF EXISTS worker_select_stores ON core.stores;
    DROP POLICY IF EXISTS service_role_all_stores ON core.stores;
    DROP POLICY IF EXISTS worker_select_identities ON core.store_zeiss_identities;
    DROP POLICY IF EXISTS service_role_all_identities ON core.store_zeiss_identities;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bd_api_zeiss_worker') THEN
        CREATE POLICY worker_select_stores ON core.stores FOR SELECT TO bd_api_zeiss_worker USING (true);
        CREATE POLICY worker_select_identities ON core.store_zeiss_identities FOR SELECT TO bd_api_zeiss_worker USING (true);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE POLICY service_role_all_stores ON core.stores FOR ALL TO service_role USING (true) WITH CHECK (true);
        CREATE POLICY service_role_all_identities ON core.store_zeiss_identities FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;
