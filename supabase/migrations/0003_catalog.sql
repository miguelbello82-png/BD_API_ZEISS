-- 0003_catalog.sql
CREATE TABLE IF NOT EXISTS catalog.catalog_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255),
    valid_from DATE,
    edition VARCHAR(50),
    source_file VARCHAR(255),
    imported_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status VARCHAR(50) DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS catalog.product_families (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID REFERENCES catalog.catalog_versions(id),
    name VARCHAR(255),
    description TEXT
);

CREATE TABLE IF NOT EXISTS catalog.commercial_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID REFERENCES catalog.product_families(id),
    name VARCHAR(255),
    category VARCHAR(100),
    design VARCHAR(100),
    material VARCHAR(100),
    refractive_index DECIMAL(4,2),
    technologies JSONB,
    prescription_ranges JSONB,
    mounting_requirements JSONB
);

CREATE TABLE IF NOT EXISTS catalog.treatments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255),
    description TEXT
);

CREATE TABLE IF NOT EXISTS catalog.price_matrix (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID REFERENCES catalog.commercial_variants(id),
    treatment_id UUID REFERENCES catalog.treatments(id),
    price DECIMAL(10,2),
    currency VARCHAR(10) DEFAULT 'BRL'
);

CREATE TABLE IF NOT EXISTS catalog.product_correlations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zeiss_product_code VARCHAR(100),
    variant_id UUID REFERENCES catalog.commercial_variants(id),
    correlation_confidence VARCHAR(50) -- EXACT, HIGH_CONFIDENCE, REVIEW_REQUIRED, UNMATCHED
);
