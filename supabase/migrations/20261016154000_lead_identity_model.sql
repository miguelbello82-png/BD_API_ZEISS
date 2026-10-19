-- 20261016154000_lead_identity_model.sql

BEGIN;

-- 1. Acquire an exclusive lock on the leads table to prevent concurrent writes
--    before we check the pre-condition and apply the DDL changes.
LOCK TABLE zeiss.leads IN SHARE ROW EXCLUSIVE MODE;

DO $$ 
DECLARE
  v_count INT;
BEGIN
  -- Pre-condition 1: leads must be empty for this strategy without backfill.
  -- The table lock guarantees no rows will be inserted between this check and the DDL.
  SELECT COUNT(*) INTO v_count FROM zeiss.leads;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Pre-condition failed: zeiss.leads must be empty to apply NOT NULL without backfill.';
  END IF;
END $$;

-- 2. Add email_hmac to leads table
ALTER TABLE zeiss.leads ADD COLUMN email_hmac VARCHAR(64);

-- 3. Set email_hmac NOT NULL
ALTER TABLE zeiss.leads ALTER COLUMN email_hmac SET NOT NULL;

-- 3.5. Drop NOT NULL on legacy lead_id column
ALTER TABLE zeiss.leads ALTER COLUMN lead_id DROP NOT NULL;

-- 4. Confirm NOT NULL on other natural key components
ALTER TABLE zeiss.leads ALTER COLUMN campaign_id SET NOT NULL;
ALTER TABLE zeiss.leads ALTER COLUMN voucher_code SET NOT NULL;

-- 5. Establish new natural identity key
ALTER TABLE zeiss.leads ADD CONSTRAINT leads_identity_key UNIQUE (campaign_id, voucher_code, email_hmac);

-- 6. Safely remove cpf_hmac and its index as it is no longer dependent
DROP INDEX IF EXISTS zeiss.idx_leads_cpf_hmac;
ALTER TABLE zeiss.leads DROP COLUMN IF EXISTS cpf_hmac;

-- NOTE: We are intentionally NOT dropping lead_id from zeiss.leads or zeiss.vouchers here.
-- Dropping zeiss.leads.lead_id is BLOCKED by the existence of app_suite.leads_view, 
-- which is out of scope for this workspace to drop or recreate.
-- The preservation of lead_id does NOT block new INSERTs because it is nullable,
-- and PostgreSQL permits multiple NULLs within a UNIQUE constraint.

COMMIT;
