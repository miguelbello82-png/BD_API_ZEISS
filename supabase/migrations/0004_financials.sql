-- 0004_financials.sql
CREATE TABLE IF NOT EXISTS zeiss.receivables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    boleto_number VARCHAR(100) UNIQUE,
    fiscal_reference VARCHAR(100),
    emission_date DATE,
    due_date DATE,
    amount DECIMAL(10,2),
    status VARCHAR(50),
    order_id UUID REFERENCES zeiss.orders(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zeiss.fiscal_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES zeiss.orders(id),
    nf_number VARCHAR(50),
    nf_series VARCHAR(10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE VIEW app_suite.receivables_view WITH (security_invoker = true) AS
SELECT 
    id,
    boleto_number,
    fiscal_reference,
    emission_date,
    due_date,
    amount,
    status,
    order_id
FROM zeiss.receivables;
