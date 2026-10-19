-- ==============================================================================
-- BD_API_ZEISS — Migration: 20261020100000_core_organizations_and_credentials.sql
-- Fase: ML-002A (Fundação Multi-Loja)
-- Objetivo: Criação do schema core, organizações e tabela segura de credenciais.
-- Idempotente e reversível.
-- ==============================================================================

-- 1. Criação do Schema Core
CREATE SCHEMA IF NOT EXISTS core;

-- Isolamento de acesso contra roles públicas ou não autorizadas
REVOKE ALL ON SCHEMA core FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON SCHEMA core FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON SCHEMA core FROM authenticated';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bd_api_zeiss_worker') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA core TO bd_api_zeiss_worker';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA core TO service_role';
    END IF;
END $$;

-- 2. Tabela core.organizations
CREATE TABLE IF NOT EXISTS core.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    cnpj_root VARCHAR(8) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_core_organizations_code UNIQUE (code),
    CONSTRAINT chk_core_org_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,48}[a-z0-9]$'),
    CONSTRAINT chk_core_org_cnpj_root CHECK (cnpj_root IS NULL OR cnpj_root ~ '^[0-9]{8}$')
);

-- 3. Tabela core.integration_credentials
CREATE TABLE IF NOT EXISTS core.integration_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES core.organizations(id) ON DELETE RESTRICT,
    provider VARCHAR(50) NOT NULL DEFAULT 'zeiss',
    name VARCHAR(100) NOT NULL,
    auth_type VARCHAR(30) NOT NULL DEFAULT 'api_key',
    secret_storage_type VARCHAR(30) NOT NULL DEFAULT 'env_ref',
    secret_ref TEXT NOT NULL,
    key_mask VARCHAR(20) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_core_credentials_id_org UNIQUE (id, organization_id),
    CONSTRAINT chk_core_cred_auth_type CHECK (auth_type IN ('api_key', 'oauth2', 'mtls')),
    CONSTRAINT chk_core_cred_storage_type CHECK (secret_storage_type IN ('env_ref', 'encrypted', 'vault_ref')),
    CONSTRAINT chk_core_cred_status CHECK (status IN ('active', 'revoked', 'expired')),
    CONSTRAINT chk_core_cred_key_mask CHECK (key_mask ~ '^\*{4}[0-9A-Za-z_-]{2,10}$')
);

-- Índices de Performance
CREATE INDEX IF NOT EXISTS idx_core_credentials_org ON core.integration_credentials(organization_id);
CREATE INDEX IF NOT EXISTS idx_core_credentials_status ON core.integration_credentials(status);

-- 4. Habilitar RLS
ALTER TABLE core.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.integration_credentials ENABLE ROW LEVEL SECURITY;

-- 5. Conceder Permissões
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bd_api_zeiss_worker') THEN
        EXECUTE 'GRANT SELECT ON core.organizations TO bd_api_zeiss_worker';
        EXECUTE 'GRANT SELECT ON core.integration_credentials TO bd_api_zeiss_worker';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT ALL ON core.organizations TO service_role';
        EXECUTE 'GRANT ALL ON core.integration_credentials TO service_role';
    END IF;
END $$;

-- 6. Políticas de RLS
DO $$
BEGIN
    DROP POLICY IF EXISTS worker_select_organizations ON core.organizations;
    DROP POLICY IF EXISTS service_role_all_organizations ON core.organizations;
    DROP POLICY IF EXISTS worker_select_credentials ON core.integration_credentials;
    DROP POLICY IF EXISTS service_role_all_credentials ON core.integration_credentials;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bd_api_zeiss_worker') THEN
        CREATE POLICY worker_select_organizations ON core.organizations FOR SELECT TO bd_api_zeiss_worker USING (true);
        CREATE POLICY worker_select_credentials ON core.integration_credentials FOR SELECT TO bd_api_zeiss_worker USING (true);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE POLICY service_role_all_organizations ON core.organizations FOR ALL TO service_role USING (true) WITH CHECK (true);
        CREATE POLICY service_role_all_credentials ON core.integration_credentials FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;
