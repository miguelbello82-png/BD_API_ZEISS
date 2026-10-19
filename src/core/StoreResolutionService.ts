import { IDatabaseExecutor } from '../config/db';
import { zeissConfig } from '../config/config';
import {
  StoreZeissContext,
  StoreStatus,
  StoreNotFoundError,
  StoreSuspendedError,
  OrganizationMismatchError
} from '../contracts/store';
import { ICredentialResolver, EnvRefCredentialResolver } from './CredentialResolver';

export interface IStoreResolutionService {
  resolveStore(identifier: string): Promise<StoreZeissContext>;
  listEligibleStores(): Promise<StoreZeissContext[]>;
}

interface StoreDbRow {
  store_id: string;
  store_code: string;
  store_status: StoreStatus;
  cnpj: string;
  organization_id: string;
  org_code: string;
  saoweb_code: string;
  zeiss_store_code: string;
  country_id: string;
  voucher_user_id: string;
  fin_user_id: string;
  leads_hmac_secret_ref: string | null;
  secret_storage_type: string;
  secret_ref: string;
  cred_status: string;
  cred_org_id: string;
  identity_org_id: string;
}

export class PgStoreResolutionService implements IStoreResolutionService {
  constructor(
    private db: IDatabaseExecutor,
    private credentialResolver: ICredentialResolver = new EnvRefCredentialResolver()
  ) {}

  async resolveStore(identifier: string): Promise<StoreZeissContext> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

    const query = `
      SELECT
        s.id as store_id,
        s.code as store_code,
        s.status as store_status,
        s.cnpj,
        s.organization_id,
        o.code as org_code,
        i.saoweb_code,
        i.zeiss_store_code,
        i.country_id,
        i.voucher_user_id,
        i.fin_user_id,
        i.leads_hmac_secret_ref,
        i.organization_id as identity_org_id,
        c.secret_storage_type,
        c.secret_ref,
        c.status as cred_status,
        c.organization_id as cred_org_id
      FROM core.stores s
      JOIN core.organizations o ON s.organization_id = o.id
      JOIN core.store_zeiss_identities i ON s.id = i.store_id
      JOIN core.integration_credentials c ON i.credential_id = c.id
      WHERE ${isUuid ? 's.id = $1::uuid' : 's.code = $1'}
    `;

    const rows = await this.db.query<StoreDbRow>(query, [identifier]);

    if (rows.length === 0) {
      throw new StoreNotFoundError(identifier);
    }

    const row = rows[0];

    // Enforce organization boundary
    if (row.organization_id !== row.identity_org_id || row.organization_id !== row.cred_org_id) {
      throw new OrganizationMismatchError(
        `Store ${row.store_code} organization mismatch between store, identity, and credential`
      );
    }

    if (row.store_status === 'suspended') {
      throw new StoreSuspendedError(row.store_code, row.store_id);
    }

    const apiKey = await this.credentialResolver.resolve({
      storageType: row.secret_storage_type,
      secretRef: row.secret_ref,
      status: row.cred_status,
      organizationId: row.organization_id
    });

    let leadsHmacSecret: string | undefined;
    if (row.leads_hmac_secret_ref) {
      leadsHmacSecret = process.env[row.leads_hmac_secret_ref] || undefined;
    }

    return {
      storeId: row.store_id,
      organizationId: row.organization_id,
      storeCode: row.store_code,
      orgCode: row.org_code,
      cnpj: row.cnpj,
      status: row.store_status,
      saowebCode: row.saoweb_code,
      zeissStoreCode: row.zeiss_store_code,
      countryId: row.country_id,
      voucherUserId: row.voucher_user_id,
      finUserId: row.fin_user_id,
      apiKey,
      leadsHmacSecret,
      ordersBaseUrl: zeissConfig.ordersBaseUrl,
      trackingBaseUrl: zeissConfig.trackingBaseUrl,
      campaignsBaseUrl: zeissConfig.campaignsBaseUrl,
      financialBaseUrl: zeissConfig.financialBaseUrl,
      servicesBaseUrl: zeissConfig.servicesBaseUrl,
    };
  }

  async listEligibleStores(): Promise<StoreZeissContext[]> {
    const query = `
      SELECT
        s.id as store_id,
        s.code as store_code,
        s.status as store_status,
        s.cnpj,
        s.organization_id,
        o.code as org_code,
        i.saoweb_code,
        i.zeiss_store_code,
        i.country_id,
        i.voucher_user_id,
        i.fin_user_id,
        i.leads_hmac_secret_ref,
        i.organization_id as identity_org_id,
        c.secret_storage_type,
        c.secret_ref,
        c.status as cred_status,
        c.organization_id as cred_org_id
      FROM core.stores s
      JOIN core.organizations o ON s.organization_id = o.id
      JOIN core.store_zeiss_identities i ON s.id = i.store_id
      JOIN core.integration_credentials c ON i.credential_id = c.id
      WHERE s.status IN ('ready', 'active')
      ORDER BY s.code ASC
    `;

    const rows = await this.db.query<StoreDbRow>(query);
    const results: StoreZeissContext[] = [];

    for (const row of rows) {
      if (row.organization_id !== row.identity_org_id || row.organization_id !== row.cred_org_id) {
        continue;
      }
      try {
        const apiKey = await this.credentialResolver.resolve({
          storageType: row.secret_storage_type,
          secretRef: row.secret_ref,
          status: row.cred_status,
          organizationId: row.organization_id
        });

        let leadsHmacSecret: string | undefined;
        if (row.leads_hmac_secret_ref) {
          leadsHmacSecret = process.env[row.leads_hmac_secret_ref] || undefined;
        }

        results.push({
          storeId: row.store_id,
          organizationId: row.organization_id,
          storeCode: row.store_code,
          orgCode: row.org_code,
          cnpj: row.cnpj,
          status: row.store_status,
          saowebCode: row.saoweb_code,
          zeissStoreCode: row.zeiss_store_code,
          countryId: row.country_id,
          voucherUserId: row.voucher_user_id,
          finUserId: row.fin_user_id,
          apiKey,
          leadsHmacSecret,
          ordersBaseUrl: zeissConfig.ordersBaseUrl,
          trackingBaseUrl: zeissConfig.trackingBaseUrl,
          campaignsBaseUrl: zeissConfig.campaignsBaseUrl,
          financialBaseUrl: zeissConfig.financialBaseUrl,
          servicesBaseUrl: zeissConfig.servicesBaseUrl,
        });
      } catch {
        // Skip stores whose credentials cannot be resolved without blocking others
      }
    }

    return results;
  }
}
