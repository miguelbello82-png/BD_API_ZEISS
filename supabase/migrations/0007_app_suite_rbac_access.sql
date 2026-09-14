-- 0007_app_suite_rbac_access.sql

-- 1. Criar a view em app_suite para expor audit.user_roles minimamente
CREATE VIEW app_suite.user_roles_view WITH (security_invoker = true) AS
SELECT 
    user_id,
    role
FROM audit.user_roles;

-- 2. Revogar privilégios públicos da nova view
REVOKE ALL ON app_suite.user_roles_view FROM PUBLIC, anon, authenticated;

-- 3. Conceder privilégio de leitura estritamente para o service_role
GRANT SELECT ON app_suite.user_roles_view TO service_role;
