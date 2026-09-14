-- 0001_orders.sql
CREATE TABLE IF NOT EXISTS zeiss.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number VARCHAR(50) UNIQUE NOT NULL,
    os_number VARCHAR(50),
    status VARCHAR(50),
    expected_date DATE,
    entry_date DATE,
    codneg VARCHAR(50),
    nomeneg VARCHAR(255),
    garantia BOOLEAN,
    pedorigar VARCHAR(50),
    antec BOOLEAN,
    motivo TEXT,
    pedoribon VARCHAR(50),
    pedconsbon VARCHAR(50),
    montagem BOOLEAN,
    aguardarmacao BOOLEAN,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Dados clínicos mínimos e estritamente necessários
CREATE TABLE IF NOT EXISTS zeiss.order_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES zeiss.orders(id) ON DELETE CASCADE,
    product_od_name VARCHAR(255),
    product_oe_name VARCHAR(255),
    timeline_summary JSONB, -- Somente datas e status agregados, sem PII
    occurrences_summary JSONB, -- Apenas tipos de ocorrência
    services_summary JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zeiss.tracking_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES zeiss.orders(id) ON DELETE CASCADE,
    nf_number VARCHAR(50),
    event_date TIMESTAMP WITH TIME ZONE,
    status VARCHAR(100),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PRD-001: Verdade técnica retornada pela API ZEISS (não confundir com catalog.*)
CREATE TABLE IF NOT EXISTS zeiss.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zeiss_product_code VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255),
    category VARCHAR(100),
    design VARCHAR(100),
    material VARCHAR(100),
    refractive_index DECIMAL(4,2),
    description TEXT,
    active BOOLEAN DEFAULT true,
    raw_api_hash VARCHAR(64), -- Hash do payload original para detectar mudanças
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zeiss.product_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES zeiss.products(id) ON DELETE CASCADE,
    service_code VARCHAR(100) NOT NULL,
    service_name VARCHAR(255),
    service_type VARCHAR(100),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(product_id, service_code)
);

CREATE VIEW app_suite.products_view WITH (security_invoker = true) AS
SELECT
    p.id,
    p.zeiss_product_code,
    p.name,
    p.category,
    p.design,
    p.material,
    p.refractive_index,
    p.description,
    p.active,
    p.synced_at
FROM zeiss.products p;

CREATE VIEW app_suite.orders_view WITH (security_invoker = true) AS
SELECT 
    o.id,
    o.order_number,
    o.os_number,
    o.status,
    o.expected_date,
    o.entry_date,
    o.codneg,
    o.nomeneg,
    o.garantia,
    o.montagem,
    o.aguardarmacao,
    o.created_at,
    (o.montagem = true AND o.aguardarmacao = true) as waiting_frame_alert
FROM zeiss.orders o;
