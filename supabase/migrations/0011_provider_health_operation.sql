-- 0011_provider_health_operation.sql (PLATFORM-NATIVE)

ALTER TABLE integration.provider_health DROP CONSTRAINT provider_health_pkey;

ALTER TABLE integration.provider_health ADD COLUMN operation VARCHAR(100) NOT NULL;

ALTER TABLE integration.provider_health ADD CONSTRAINT provider_health_pkey PRIMARY KEY (provider, domain, operation);
