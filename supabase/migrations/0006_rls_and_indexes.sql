-- 0006_rls_and_indexes.sql

-- 1. REVOKE EXPLICITO DE PRIVILÉGIOS (Schemas e Conteúdo)
REVOKE ALL ON SCHEMA zeiss FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SCHEMA catalog FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SCHEMA integration FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SCHEMA audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SCHEMA app_suite FROM PUBLIC, anon, authenticated;

-- Revogar de todas as tabelas, funções e sequences atuais
REVOKE ALL ON ALL TABLES IN SCHEMA zeiss, catalog, integration, audit, app_suite FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL ROUTINES IN SCHEMA zeiss, catalog, integration, audit, app_suite FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA zeiss, catalog, integration, audit, app_suite FROM PUBLIC, anon, authenticated;

-- Alterar privilégios padrão para futuras criações
ALTER DEFAULT PRIVILEGES IN SCHEMA zeiss, catalog, integration, audit, app_suite REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA zeiss, catalog, integration, audit, app_suite REVOKE ALL ON ROUTINES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA zeiss, catalog, integration, audit, app_suite REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

-- 2. GRANTS EXPLÍCITOS PARA SERVICE_ROLE (Mínimo Privilégio)
-- Schemas
GRANT USAGE ON SCHEMA app_suite, zeiss, catalog, integration, audit TO service_role;
-- App Suite (Views)
GRANT SELECT ON ALL TABLES IN SCHEMA app_suite TO service_role;

-- Zeiss (Tabelas operacionais)
GRANT SELECT, INSERT, UPDATE ON TABLE zeiss.orders TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE zeiss.order_details TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE zeiss.tracking_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE zeiss.campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE zeiss.leads TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE zeiss.vouchers TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE zeiss.receivables TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE zeiss.fiscal_documents TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE zeiss.products TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE zeiss.product_services TO service_role;

-- Catalog (Somente leitura — atualizações via ingestão/migration específica)
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO service_role;

-- Integration (Syncs e estados operacionais)
GRANT SELECT, INSERT, UPDATE ON TABLE integration.sync_runs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE integration.provider_health TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE integration.sync_state TO service_role;

-- Audit (Append-only de eventos e leitura de roles)
GRANT SELECT, INSERT ON TABLE audit.events TO service_role;
GRANT SELECT ON TABLE audit.user_roles TO service_role;

-- 3. ENABLE ROW LEVEL SECURITY EM TODAS AS 21 TABELAS

-- ZEISS (10)
ALTER TABLE zeiss.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE zeiss.order_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE zeiss.tracking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE zeiss.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE zeiss.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE zeiss.vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE zeiss.receivables ENABLE ROW LEVEL SECURITY;
ALTER TABLE zeiss.fiscal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE zeiss.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE zeiss.product_services ENABLE ROW LEVEL SECURITY;

-- CATALOG (6)
ALTER TABLE catalog.catalog_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.product_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.commercial_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.treatments ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_matrix ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.product_correlations ENABLE ROW LEVEL SECURITY;

-- INTEGRATION (3)
ALTER TABLE integration.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.provider_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.sync_state ENABLE ROW LEVEL SECURITY;

-- AUDIT (2)
ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.user_roles ENABLE ROW LEVEL SECURITY;

-- 4. INDEXES
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON zeiss.orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_codneg ON zeiss.orders(codneg);
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON zeiss.leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_cpf_hmac ON zeiss.leads(cpf_hmac);
CREATE INDEX IF NOT EXISTS idx_receivables_order ON zeiss.receivables(order_id);
CREATE INDEX IF NOT EXISTS idx_events_actor ON audit.events(actor_id);
CREATE INDEX IF NOT EXISTS idx_products_code ON zeiss.products(zeiss_product_code);
CREATE INDEX IF NOT EXISTS idx_product_services_product ON zeiss.product_services(product_id);
