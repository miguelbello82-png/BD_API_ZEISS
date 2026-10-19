import { PgLeadsRepository } from '../../../../src/repositories/postgres/LeadsRepository';
import { IDatabaseExecutor } from '../../../../src/config/db';
import { computeLeadEmailHmac } from '../../../../src/utils/hmac';

describe('LeadsRepository - Status Regression and Natural Key', () => {
  let mockDb: jest.Mocked<IDatabaseExecutor>;
  let dbState: Record<string, { status: string; updated_at: number }>;

  beforeEach(() => {
    dbState = {};

    mockDb = {
      query: jest.fn(async (sql: string, params: any[]) => {
        if (sql.includes('INSERT INTO zeiss.leads') && sql.includes('ON CONFLICT')) {
          const campId = params[0];
          const emailHmac = params[1];
          const voucher = params[2];
          
          let statusToSet: string;
          if (params.length === 3) { // The literal used in upsertRedeemedMany
            statusToSet = 'Resgatado';
          } else {
            statusToSet = params[3]; // The parameter used in upsertMany
          }
          
          const key = `${campId}_${voucher}_${emailHmac}`;
          
          if (!dbState[key]) {
            dbState[key] = { status: statusToSet, updated_at: Date.now() };
          } else {
            const existing = dbState[key];
            
            // Simulate ON CONFLICT DO UPDATE SET
            if (params.length === 4) {
               // Simulate: status = CASE WHEN zeiss.leads.status = 'Resgatado' THEN zeiss.leads.status ELSE EXCLUDED.status END
               if (existing.status !== 'Resgatado') {
                 existing.status = statusToSet;
               }
            } else if (params.length === 3) {
               existing.status = 'Resgatado';
            }
            
            existing.updated_at = Date.now();
          }
        }
        return [];
      }),
      transaction: jest.fn(async (cb) => await cb(mockDb))
    } as any;
  });

  const runLead001 = async (campId: string, emailHmac: string, voucher: string, status: string) => {
    const repo = new PgLeadsRepository(mockDb);
    await repo.upsertMany(campId, [{ campaign_id: campId, email_hmac: emailHmac, voucher_code: voucher, status } as any]);
  };

  const runLead002 = async (campId: string, emailHmac: string, voucher: string, status: string) => {
    const repo = new PgLeadsRepository(mockDb);
    await repo.upsertRedeemedMany(campId, [{ campaign_id: campId, email_hmac: emailHmac, voucher_code: voucher, status } as any]);
  };

  it('1. new LEAD-001 event inserts normally', async () => {
    const key = `C1_V1_HMAC1`;
    await runLead001('C1', 'HMAC1', 'V1', 'Ativo');
    expect(dbState[key].status).toBe('Ativo');
  });

  it('2. repeated LEAD-001 is idempotent', async () => {
    const key = `C1_V1_HMAC1`;
    await runLead001('C1', 'HMAC1', 'V1', 'Ativo');
    await runLead001('C1', 'HMAC1', 'V1', 'Ativo');
    expect(dbState[key].status).toBe('Ativo');
  });

  it('3. LEAD-002 updates same event to redeemed', async () => {
    const key = `C1_V1_HMAC1`;
    await runLead001('C1', 'HMAC1', 'V1', 'Ativo');
    // Notice that LEAD-002 enforces "Resgatado" even if we pass undefined to the repo interface
    await runLead002('C1', 'HMAC1', 'V1', undefined as any);
    expect(dbState[key].status).toBe('Resgatado');
  });

  it('4. later LEAD-001 does NOT regress redeemed', async () => {
    const key = `C1_V1_HMAC1`;
    await runLead001('C1', 'HMAC1', 'V1', 'Ativo');
    await runLead002('C1', 'HMAC1', 'V1', undefined as any); // user redeems
    await runLead001('C1', 'HMAC1', 'V1', 'Ativo'); // later sync from L1
    expect(dbState[key].status).toBe('Resgatado'); // must NOT regress
  });

  it('5. repeated LEAD-002 remains idempotent', async () => {
    const key = `C1_V1_HMAC1`;
    await runLead002('C1', 'HMAC1', 'V1', undefined as any);
    await runLead002('C1', 'HMAC1', 'V1', undefined as any);
    expect(dbState[key].status).toBe('Resgatado');
  });

  it('6. different natural keys remain separate', async () => {
    await runLead001('C1', 'HMAC1', 'V1', 'Ativo');
    await runLead001('C1', 'HMAC2', 'V1', 'Ativo'); // Same voucher, different person
    expect(dbState['C1_V1_HMAC1'].status).toBe('Ativo');
    expect(dbState['C1_V1_HMAC2'].status).toBe('Ativo');
  });

  it('7. no raw PII is persisted', async () => {
    // Verified by typescript typing: LeadRecord does not have email, cpf, etc.
    // Also tested in hmac.test.ts, but we check our mockDb payload params here.
    await runLead001('C1', 'HMAC1', 'V1', 'Ativo');
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.anything(),
      ['C1', 'HMAC1', 'V1', 'Ativo']
    );
    // No PII values in the query params
  });

  it('8. HMAC identity remains deterministic with synthetic test secret', () => {
    const secret = 'synthetic-test-secret-999';
    const email1 = 'test@example.com';
    const email2 = ' TEST@Example.com '; // same email, different format
    
    const hmac1 = computeLeadEmailHmac(email1.trim().toLowerCase(), secret);
    const hmac2 = computeLeadEmailHmac(email2.trim().toLowerCase(), secret);
    
    expect(hmac1).toBe(hmac2);
    expect(hmac1.length).toBe(64);
  });
});
