-- 0008_app_suite_catalog_price_matrix_view.sql

CREATE VIEW app_suite.catalog_price_matrix_view
WITH (security_invoker = true) AS
SELECT
    pm.id,
    ver.id AS catalog_version_id,
    ver.edition AS catalog_edition,
    ver.valid_from AS catalog_valid_from,
    ver.status AS catalog_status,
    pf.name AS family_name,
    cv.name AS variant_name,
    cv.refractive_index,
    cv.material,
    cv.category,
    cv.design,
    tr.name AS treatment_name,
    pm.price,
    pm.currency
FROM catalog.price_matrix pm
JOIN catalog.commercial_variants cv
    ON pm.variant_id = cv.id
JOIN catalog.product_families pf
    ON cv.family_id = pf.id
JOIN catalog.catalog_versions ver
    ON pf.version_id = ver.id
LEFT JOIN catalog.treatments tr
    ON pm.treatment_id = tr.id;

REVOKE ALL ON app_suite.catalog_price_matrix_view
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON app_suite.catalog_price_matrix_view
TO service_role;
