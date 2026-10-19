-- ==============================================================================
-- BD_API_ZEISS — Migration: 20261020110001_zeiss_store_campaigns.sql
-- Fase: ML-002B (Isolamento Operacional Multi-Loja)
-- Objetivo: Criar zeiss.store_campaigns para adesão e aceite de campanhas por loja,
--           preservando o catálogo global de campanhas em zeiss.campaigns.
-- Idempotente e reversível.
-- ==============================================================================

-- 1. Criação da tabela zeiss.store_campaigns
CREATE TABLE IF NOT EXISTS zeiss.store_campaigns (
    store_id UUID NOT NULL REFERENCES core.stores(id) ON DELETE RESTRICT,
    campaign_id VARCHAR(50) NOT NULL REFERENCES zeiss.campaigns(campaign_id) ON DELETE RESTRICT,
    aceite BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(50) NULL,
    incentive_type VARCHAR(100) NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_zeiss_store_campaigns PRIMARY KEY (store_id, campaign_id)
);

-- Índices de Performance
CREATE INDEX IF NOT EXISTS idx_zeiss_store_campaigns_store ON zeiss.store_campaigns(store_id);
CREATE INDEX IF NOT EXISTS idx_zeiss_store_campaigns_campaign ON zeiss.store_campaigns(campaign_id);
CREATE INDEX IF NOT EXISTS idx_zeiss_store_campaigns_aceite ON zeiss.store_campaigns(store_id, aceite);

-- 2. Habilitar RLS
ALTER TABLE zeiss.store_campaigns ENABLE ROW LEVEL SECURITY;

-- 3. Conceder Permissões
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bd_api_zeiss_worker') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON zeiss.store_campaigns TO bd_api_zeiss_worker';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT ALL ON zeiss.store_campaigns TO service_role';
    END IF;
END $$;

-- 4. Políticas de RLS
DO $$
BEGIN
    DROP POLICY IF EXISTS worker_store_campaigns_all ON zeiss.store_campaigns;
    DROP POLICY IF EXISTS service_role_store_campaigns_all ON zeiss.store_campaigns;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bd_api_zeiss_worker') THEN
        CREATE POLICY worker_store_campaigns_all ON zeiss.store_campaigns FOR ALL TO bd_api_zeiss_worker USING (true) WITH CHECK (true);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE POLICY service_role_store_campaigns_all ON zeiss.store_campaigns FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;
