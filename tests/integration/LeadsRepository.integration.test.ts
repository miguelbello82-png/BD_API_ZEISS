import { Pool } from 'pg';
import { PgDatabaseExecutor } from '../../src/config/db';
import { PgLeadsRepository } from '../../src/repositories/postgres/LeadsRepository';
import { LeadRecord } from '../../src/contracts/types';
import * as fs from 'fs';
import * as path from 'path';

describe('LeadsRepository - Real PostgreSQL Integration', () => {
  let pool: Pool;
  let db: PgDatabaseExecutor;
  let repo: PgLeadsRepository;

  const getDdl = () => {
    return `
      CREATE SCHEMA IF NOT EXISTS zeiss;
      CREATE TABLE IF NOT EXISTS zeiss.leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id VARCHAR(50) NOT NULL,
        status VARCHAR(50),
        voucher_code VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        lead_id VARCHAR(100) NOT NULL UNIQUE,
        cpf_hmac VARCHAR(64)
      );
      CREATE INDEX IF NOT EXISTS idx_leads_cpf_hmac ON zeiss.leads(cpf_hmac);
    `;
  };

  const getMigrationTimestamped = () => {
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/20261016154000_lead_identity_model.sql');
    return fs.readFileSync(migrationPath, 'utf8');
  };

  beforeAll(async () => {
    // 1. Mandatory test environment assertion
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('SECURITY VIOLATION: Integration tests can only execute when NODE_ENV is set to "test".');
    }

    const rawConnStr = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/zeiss_test';

    // 2. Prevent accidental reuse of production or shared connection string
    if (process.env.DATABASE_URL && rawConnStr.trim() === process.env.DATABASE_URL.trim()) {
      throw new Error('SECURITY VIOLATION: TEST_DATABASE_URL cannot match DATABASE_URL. Integration tests require an isolated test database.');
    }

    // 3. Strict loopback host validation on connection string
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawConnStr);
    } catch (err) {
      throw new Error(`SECURITY VIOLATION: Malformed TEST_DATABASE_URL: ${err instanceof Error ? err.message : String(err)}`);
    }

    const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    if (!allowedHosts.has(parsedUrl.hostname.toLowerCase())) {
      throw new Error(
        `SECURITY VIOLATION: Integration tests with destructive operations (DROP/DELETE) are strictly prohibited against external/non-loopback hosts. Detected host: "${parsedUrl.hostname}". Aborting immediately before any database interaction.`
      );
    }

    // 4. Configure connection pool with explicit safety timeout
    pool = new Pool({
      connectionString: rawConnStr,
      connectionTimeoutMillis: 5000,
    });
    db = new PgDatabaseExecutor(pool);
    repo = new PgLeadsRepository(db);

    // 5. Query and assert runtime socket server address directly from PostgreSQL engine
    const res = await pool.query(`
      SELECT 
        current_database() AS db_name, 
        current_user AS db_user, 
        version(),
        inet_server_addr() AS server_addr
    `);
    const dbInfo = res.rows[0];
    const serverAddr = dbInfo.server_addr ? String(dbInfo.server_addr).replace(/\/.*$/, '') : '127.0.0.1';

    if (!allowedHosts.has(serverAddr)) {
      await pool.end();
      throw new Error(
        `SECURITY VIOLATION: Database server reported non-loopback IP (${serverAddr}). Aborting immediately before executing any DDL/destructive commands.`
      );
    }

    // 6. Safeguard database name against production patterns
    const dbName = String(dbInfo.db_name).toLowerCase();
    if (dbName.includes('prod') || dbName.includes('supabase')) {
      await pool.end();
      throw new Error(
        `SECURITY VIOLATION: Database name "${dbInfo.db_name}" contains protected keyword ('prod' or 'supabase'). Aborting.`
      );
    }

    // 7. ANTI-TUNNEL BARRIER: Detect Cloud / Managed Platform Schemas (Supabase, AWS RDS, etc.)
    // If an SSH tunnel or port-forwarding proxies 127.0.0.1:5433 to a cloud instance,
    // platform-managed schemas will be present in pg_namespace.
    const cloudCheck = await pool.query(`
      SELECT nspname FROM pg_namespace 
      WHERE nspname IN ('auth', 'storage', 'vault', 'supabase_functions', 'pgsodium', 'graphql_public')
    `);
    if (cloudCheck.rows.length > 0) {
      await pool.end();
      const detected = cloudCheck.rows.map(r => r.nspname).join(', ');
      throw new Error(
        `SECURITY VIOLATION (ANTI-TUNNEL): Target database contains managed cloud platform schemas [${detected}]. ` +
        `Execution aborted: target is an external/managed cloud database reached via local tunnel or port-forward!`
      );
    }

    // 8. MANDATORY DEDICATED TEST DATABASE: Zero bypasses permitted
    // The target database MUST be exclusively and unconditionally dedicated to testing.
    // Generic, default or shared databases (such as standard "postgres", "defaultdb", etc.) are strictly rejected.
    // No environment variable or configuration flag can bypass this requirement.
    const isDedicatedTestDb = dbName.endsWith('_test') || dbName === 'postgres_test' || dbName === 'zeiss_test';
    if (!isDedicatedTestDb) {
      await pool.end();
      throw new Error(
        `SECURITY VIOLATION: Target database "${dbInfo.db_name}" is NOT an exclusively dedicated test database. ` +
        `Destructive operations (DROP/DELETE) are strictly prohibited unless the database is explicitly dedicated to tests (e.g. "*_test", "zeiss_test", "postgres_test"). ` +
        `No bypass permitted. Execution aborted.`
      );
    }

    console.log(`INTEGRATION DB SECURE: Host=${parsedUrl.hostname} ServerAddr=${serverAddr} DB=${dbInfo.db_name} User=${dbInfo.db_user}`);
    
    // Setup fresh schema (only executes after all security barriers have passed)
    await pool.query('DROP SCHEMA IF EXISTS zeiss CASCADE');
    await pool.query(getDdl());
    await pool.query(getMigrationTimestamped());
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  beforeEach(async () => {
    // Clean table before each test
    await pool.query('DELETE FROM zeiss.leads');
  });

  it('A. LEAD001 -> LEAD002', async () => {
    await repo.upsertMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: 'Ativo' } as any]);
    await repo.upsertRedeemedMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: null } as any]);
    
    const rows = await pool.query('SELECT * FROM zeiss.leads');
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].status).toBe('Resgatado');
  });

  it('B. LEAD002 -> LEAD001', async () => {
    await repo.upsertRedeemedMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: null } as any]);
    await repo.upsertMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: 'Ativo' } as any]);
    
    const rows = await pool.query('SELECT * FROM zeiss.leads');
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].status).toBe('Resgatado');
  });

  it('C. LEAD001 -> LEAD002 -> LEAD001', async () => {
    await repo.upsertMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: 'Ativo' } as any]);
    const res1 = await pool.query('SELECT id FROM zeiss.leads');
    const id1 = res1.rows[0].id;

    await repo.upsertRedeemedMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: null } as any]);
    await repo.upsertMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: 'Ativo' } as any]);
    
    const rows = await pool.query('SELECT * FROM zeiss.leads');
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].status).toBe('Resgatado');
    expect(rows.rows[0].id).toBe(id1); // UUID preserved
  });

  it('D. repetição dos eventos', async () => {
    await repo.upsertMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: 'Ativo' } as any]);
    await repo.upsertMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: 'Ativo' } as any]);
    
    const rows = await pool.query('SELECT * FROM zeiss.leads');
    expect(rows.rowCount).toBe(1);
  });

  it('E. eventos com chaves distintas e atualizações permitidas de LEAD001', async () => {
    await repo.upsertMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: 'Ativo' } as any]);
    await repo.upsertMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H2', status: 'Ativo' } as any]);
    
    let rows = await pool.query('SELECT * FROM zeiss.leads ORDER BY email_hmac');
    expect(rows.rowCount).toBe(2);

    await repo.upsertMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: 'H1', status: 'Cancelado' } as any]);
    rows = await pool.query('SELECT * FROM zeiss.leads ORDER BY email_hmac');
    expect(rows.rows[0].status).toBe('Cancelado'); // Allowed because it is not Resgatado
    expect(rows.rows[1].status).toBe('Ativo');
  });

  it('F. rejeição de componentes nulos da chave', async () => {
    await expect(repo.upsertMany(null as any, [{ voucher_code: 'V1', email_hmac: 'H1', status: 'Ativo' } as any])).rejects.toThrow();
    await expect(repo.upsertMany('C1', [{ voucher_code: null, email_hmac: 'H1', status: 'Ativo' } as any])).rejects.toThrow();
    await expect(repo.upsertMany('C1', [{ campaign_id: 'C1', voucher_code: 'V1', email_hmac: null, status: 'Ativo' } as any])).rejects.toThrow();
  });

  it('G. migration schema validation', async () => {
    // The schema was already migrated in beforeAll
    const colRes = await pool.query(`
      SELECT column_name, is_nullable 
      FROM information_schema.columns 
      WHERE table_schema = 'zeiss' AND table_name = 'leads' AND column_name = 'lead_id'
    `);
    expect(colRes.rows[0].is_nullable).toBe('YES'); // B. lead_id ficou nullable

    const ucRes = await pool.query(`
      SELECT tc.constraint_type 
      FROM information_schema.table_constraints tc 
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_schema = 'zeiss' AND tc.table_name = 'leads' AND kcu.column_name = 'lead_id' AND tc.constraint_type = 'UNIQUE'
    `);
    expect(ucRes.rowCount).toBeGreaterThan(0); // C. UNIQUE em lead_id continua existindo

    const pkRes = await pool.query(`
      SELECT tc.constraint_type 
      FROM information_schema.table_constraints tc 
      WHERE tc.table_schema = 'zeiss' AND tc.table_name = 'leads' AND tc.constraint_name = 'leads_pkey'
    `);
    expect(pkRes.rows[0].constraint_type).toBe('PRIMARY KEY'); // D. PK id UUID preservada

    const newUcRes = await pool.query(`
      SELECT tc.constraint_type 
      FROM information_schema.table_constraints tc 
      WHERE tc.table_schema = 'zeiss' AND tc.table_name = 'leads' AND tc.constraint_name = 'leads_identity_key'
    `);
    expect(newUcRes.rows[0].constraint_type).toBe('UNIQUE'); // E. UNIQUE nova

    const cpfRes = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'zeiss' AND table_name = 'leads' AND column_name = 'cpf_hmac'
    `);
    expect(cpfRes.rowCount).toBe(0); // F. cpf_hmac removido
  });

  it('H. migration violates preconditions (not empty)', async () => {
    // We recreate the schema bypassing the initial setup
    await pool.query('DROP SCHEMA IF EXISTS zeiss CASCADE');
    await pool.query(getDdl());
    await pool.query(`INSERT INTO zeiss.leads (campaign_id, voucher_code, lead_id) VALUES ('C1', 'V1', 'DUMMY')`); // requires lead_id now!

    await expect(pool.query(getMigrationTimestamped())).rejects.toThrow(/Pre-condition failed/);
  });
});
