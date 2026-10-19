-- ==============================================================================
-- BD_API_ZEISS — Migration: 20261020110000_zeiss_add_store_id_operational.sql
-- Fase: ML-002B (Isolamento Operacional Multi-Loja)
-- Objetivo: Adicionar coluna store_id (NULLABLE) nas tabelas operacionais da ZEISS.
-- Regras obrigatórias:
--   - Preservar todas as linhas existentes (permanecem com store_id = NULL).
--   - Não atribuir automaticamente registros históricos à Continental.
--   - Não remover constraints de unicidade existentes.
--   - Não modificar tabelas de catálogo (products, product_services).
--   - Criar índices adequados para consultas filtradas por loja.
-- Idempotente e reversível.
-- ==============================================================================

-- 1. zeiss.orders
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'zeiss' AND table_name = 'orders' AND column_name = 'store_id'
    ) THEN
        ALTER TABLE zeiss.orders 
            ADD COLUMN store_id UUID NULL REFERENCES core.stores(id) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_zeiss_orders_store_id ON zeiss.orders(store_id);

-- 2. zeiss.order_details
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'zeiss' AND table_name = 'order_details' AND column_name = 'store_id'
    ) THEN
        ALTER TABLE zeiss.order_details 
            ADD COLUMN store_id UUID NULL REFERENCES core.stores(id) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_zeiss_order_details_store_id ON zeiss.order_details(store_id);

-- 3. zeiss.tracking_events
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'zeiss' AND table_name = 'tracking_events' AND column_name = 'store_id'
    ) THEN
        ALTER TABLE zeiss.tracking_events 
            ADD COLUMN store_id UUID NULL REFERENCES core.stores(id) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_zeiss_tracking_events_store_id ON zeiss.tracking_events(store_id);

-- 4. zeiss.fiscal_documents
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'zeiss' AND table_name = 'fiscal_documents' AND column_name = 'store_id'
    ) THEN
        ALTER TABLE zeiss.fiscal_documents 
            ADD COLUMN store_id UUID NULL REFERENCES core.stores(id) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_zeiss_fiscal_documents_store_id ON zeiss.fiscal_documents(store_id);

-- 5. zeiss.receivables
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'zeiss' AND table_name = 'receivables' AND column_name = 'store_id'
    ) THEN
        ALTER TABLE zeiss.receivables 
            ADD COLUMN store_id UUID NULL REFERENCES core.stores(id) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_zeiss_receivables_store_id ON zeiss.receivables(store_id);

-- 6. zeiss.leads
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'zeiss' AND table_name = 'leads' AND column_name = 'store_id'
    ) THEN
        ALTER TABLE zeiss.leads 
            ADD COLUMN store_id UUID NULL REFERENCES core.stores(id) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_zeiss_leads_store_id ON zeiss.leads(store_id);

-- 7. zeiss.vouchers
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'zeiss' AND table_name = 'vouchers' AND column_name = 'store_id'
    ) THEN
        ALTER TABLE zeiss.vouchers 
            ADD COLUMN store_id UUID NULL REFERENCES core.stores(id) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_zeiss_vouchers_store_id ON zeiss.vouchers(store_id);
