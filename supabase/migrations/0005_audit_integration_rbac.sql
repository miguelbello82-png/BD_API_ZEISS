-- 0005_audit_integration_rbac.sql
CREATE TABLE IF NOT EXISTS audit.events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100),
    actor_id UUID,
    resource VARCHAR(255),
    action VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration.sync_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(100),
    domain VARCHAR(100),
    operation VARCHAR(100),
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    finished_at TIMESTAMP WITH TIME ZONE,
    duration_ms INT,
    status VARCHAR(50),
    http_status INT,
    volume INT,
    sync_cursor VARCHAR(255),
    error_category VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS integration.provider_health (
    provider VARCHAR(100) PRIMARY KEY,
    last_success TIMESTAMP WITH TIME ZONE,
    last_failure TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS integration.sync_state (
    domain VARCHAR(100) PRIMARY KEY,
    last_sync TIMESTAMP WITH TIME ZONE,
    cursor_value VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS audit.user_roles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL CHECK (role IN ('ADMIN', 'GERENTE', 'OPERADOR', 'CONSULTA')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE VIEW app_suite.integration_health_view WITH (security_invoker = true) AS
SELECT 
    provider,
    last_success,
    last_failure,
    status
FROM integration.provider_health;
