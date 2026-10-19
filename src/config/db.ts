import { Pool, PoolClient, QueryResultRow } from 'pg';

export interface IDatabaseExecutor {
  /** Execute a parameterized SQL query */
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
  
  /** Execute a callback within a database transaction */
  transaction<T>(callback: (client: IDatabaseExecutor) => Promise<T>): Promise<T>;
}

export class PgDatabaseExecutor implements IDatabaseExecutor {
  constructor(private poolOrClient: Pool | PoolClient) {}

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]> {
    const result = await this.poolOrClient.query<R>(sql, params);
    return result.rows;
  }

  async transaction<T>(callback: (client: IDatabaseExecutor) => Promise<T>): Promise<T> {
    // If it's already a PoolClient, we're already inside a transaction conceptually
    // (Nested transactions would require SAVEPOINT, omitted for simplicity)
    if ('release' in this.poolOrClient && typeof this.poolOrClient.release === 'function') {
      return callback(this);
    }

    const pool = this.poolOrClient as Pool;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const executor = new PgDatabaseExecutor(client);
      const result = await callback(executor);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

const SUPABASE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----`;

/**
 * Creates a PostgreSQL pool from the DATABASE_URL environment variable.
 * Does NOT automatically connect on import.
 */
export function createPgPool(connectionString?: string): Pool {
  const rawUrl = connectionString || process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error('DATABASE_URL is not defined in the environment.');
  }

  // If connection points to Supabase, configure SSL with the canonical CA certificate
  if (rawUrl.includes('supabase.co') || rawUrl.includes('pooler.supabase.com')) {
    try {
      const parsed = new URL(rawUrl);
      parsed.searchParams.delete('sslrootcert');
      parsed.searchParams.delete('sslmode');
      return new Pool({
        connectionString: parsed.toString(),
        ssl: {
          ca: process.env.DATABASE_SSL_CA || SUPABASE_ROOT_CA,
          rejectUnauthorized: true,
        },
      });
    } catch {
      // Fallback to raw URL if URL parsing fails
    }
  }

  return new Pool({ connectionString: rawUrl });
}
