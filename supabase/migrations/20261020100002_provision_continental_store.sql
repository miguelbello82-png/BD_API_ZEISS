-- ==============================================================================
-- BD_API_ZEISS — Migration: 20261020100002_provision_continental_store.sql
-- Fase: ML-002A (Provisionamento Cadastral da Continental)
-- Objetivo: Cadastro inicial idempotente da Organização, Credencial e Loja Continental.
-- ZERO TOUCH nas tabelas zeiss.* e nos 7.180 pedidos históricos.
-- ==============================================================================

DO $$
DECLARE
    v_org_id UUID;
    v_cred_id UUID;
    v_store_id UUID;
BEGIN
    -- 1. Inserir Organização Continental
    INSERT INTO core.organizations (code, name, cnpj_root)
    VALUES ('continental-group', 'Grupo Ótica Continental', '48310092')
    ON CONFLICT (code) DO UPDATE 
        SET name = EXCLUDED.name,
            cnpj_root = EXCLUDED.cnpj_root,
            updated_at = CURRENT_TIMESTAMP
    RETURNING id INTO v_org_id;

    -- 2. Inserir Credencial ZEISS Master (env_ref apontando para ZEISS_API_KEY)
    SELECT id INTO v_cred_id
    FROM core.integration_credentials
    WHERE organization_id = v_org_id AND name = 'Credencial ZEISS Principal - Continental'
    LIMIT 1;

    IF v_cred_id IS NULL THEN
        INSERT INTO core.integration_credentials (
            organization_id,
            provider,
            name,
            auth_type,
            secret_storage_type,
            secret_ref,
            key_mask,
            status
        )
        VALUES (
            v_org_id,
            'zeiss',
            'Credencial ZEISS Principal - Continental',
            'api_key',
            'env_ref',
            'ZEISS_API_KEY',
            '****env1',
            'active'
        )
        RETURNING id INTO v_cred_id;
    END IF;

    -- 3. Inserir Loja Continental Matriz
    INSERT INTO core.stores (
        organization_id,
        code,
        name,
        cnpj,
        status
    )
    VALUES (
        v_org_id,
        'continental',
        'Ótica Continental',
        '48310092000132',
        'ready'
    )
    ON CONFLICT (code) DO UPDATE 
        SET name = EXCLUDED.name,
            cnpj = EXCLUDED.cnpj,
            status = 'ready',
            updated_at = CURRENT_TIMESTAMP
    RETURNING id INTO v_store_id;

    -- 4. Inserir Identidade Técnica ZEISS da Continental
    INSERT INTO core.store_zeiss_identities (
        store_id,
        organization_id,
        credential_id,
        country_id,
        saoweb_code,
        zeiss_store_code,
        voucher_user_id,
        fin_user_id,
        leads_hmac_secret_ref
    )
    VALUES (
        v_store_id,
        v_org_id,
        v_cred_id,
        '1',
        '33417',
        'CN043229',
        '42',
        '0',
        'ZEISS_LEADS_HMAC_SECRET'
    )
    ON CONFLICT (store_id) DO UPDATE 
        SET credential_id = EXCLUDED.credential_id,
            country_id = EXCLUDED.country_id,
            saoweb_code = EXCLUDED.saoweb_code,
            zeiss_store_code = EXCLUDED.zeiss_store_code,
            voucher_user_id = EXCLUDED.voucher_user_id,
            fin_user_id = EXCLUDED.fin_user_id,
            leads_hmac_secret_ref = EXCLUDED.leads_hmac_secret_ref,
            updated_at = CURRENT_TIMESTAMP;

    RAISE NOTICE 'Provisionamento cadastral da Continental concluído com sucesso. Store ID: %', v_store_id;
END $$;
