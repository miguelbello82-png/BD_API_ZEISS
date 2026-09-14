-- 0002_campaigns_vouchers.sql
CREATE TABLE IF NOT EXISTS zeiss.campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id VARCHAR(100) UNIQUE NOT NULL,
    title VARCHAR(255),
    slogan VARCHAR(255),
    description TEXT,
    start_date DATE,
    end_date DATE,
    status VARCHAR(50),
    aceite BOOLEAN DEFAULT false,
    incentive_type VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zeiss.leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id VARCHAR(100) REFERENCES zeiss.campaigns(campaign_id),
    lead_id VARCHAR(100) UNIQUE NOT NULL,
    cpf_hmac VARCHAR(64), -- HMAC-SHA256(CPF_NORMALIZADO, CPF_LOOKUP_SECRET), nunca plaintext
    status VARCHAR(50),
    voucher_code VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zeiss.vouchers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_code VARCHAR(100) UNIQUE NOT NULL,
    campaign_id VARCHAR(100) REFERENCES zeiss.campaigns(campaign_id),
    lead_id VARCHAR(100) REFERENCES zeiss.leads(lead_id),
    status VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE VIEW app_suite.campaigns_view WITH (security_invoker = true) AS
SELECT 
    campaign_id,
    title,
    slogan,
    description,
    start_date,
    end_date,
    status,
    aceite,
    incentive_type
FROM zeiss.campaigns;

CREATE VIEW app_suite.leads_view WITH (security_invoker = true) AS
SELECT 
    lead_id,
    campaign_id,
    status,
    voucher_code,
    created_at
FROM zeiss.leads;
