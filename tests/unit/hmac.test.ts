import { normalizeLeadEmail, computeLeadEmailHmac } from '../../src/utils/hmac';
import { LeadMapper, ContractMappingError } from '../../src/engine/Mappers';

describe('HMAC and Lead Identity Model', () => {
  const TEST_SECRET = 'synthetic-test-secret-12345';

  describe('normalizeLeadEmail', () => {
    it('normalizes case and whitespace', () => {
      expect(normalizeLeadEmail(' TEST@Example.com ')).toBe('test@example.com');
      expect(normalizeLeadEmail('   hello@WORLD.com')).toBe('hello@world.com');
    });

    it('returns empty string for falsy values', () => {
      expect(normalizeLeadEmail(null)).toBe('');
      expect(normalizeLeadEmail(undefined)).toBe('');
      expect(normalizeLeadEmail('')).toBe('');
    });
  });

  describe('computeLeadEmailHmac', () => {
    it('computes deterministic HMAC', () => {
      const hmac1 = computeLeadEmailHmac('test@example.com', TEST_SECRET);
      const hmac2 = computeLeadEmailHmac('test@example.com', TEST_SECRET);
      expect(hmac1).toBe(hmac2);
      expect(hmac1.length).toBe(64); // SHA-256 hex is 64 chars
    });

    it('different emails -> different HMAC', () => {
      const hmac1 = computeLeadEmailHmac('a@test.com', TEST_SECRET);
      const hmac2 = computeLeadEmailHmac('b@test.com', TEST_SECRET);
      expect(hmac1).not.toBe(hmac2);
    });

    it('case/whitespace normalization -> same HMAC', () => {
      const normalized = normalizeLeadEmail(' TEST@example.COM ');
      const hmac1 = computeLeadEmailHmac(normalized, TEST_SECRET);
      const hmac2 = computeLeadEmailHmac('test@example.com', TEST_SECRET);
      expect(hmac1).toBe(hmac2);
    });

    it('throws if email or secret is missing', () => {
      expect(() => computeLeadEmailHmac('', TEST_SECRET)).toThrow();
      expect(() => computeLeadEmailHmac('test@example.com', '')).toThrow();
    });
  });

  describe('LeadMapper.normalize', () => {
    it('maps valid lead payload and computes HMAC without persisting raw PII', () => {
      const raw = {
        voucher: 'VOUCHER-123',
        email: '  TEST@lead.com ',
        status: 'Ativo',
        nome: 'John Doe',
        telefone: '123456789'
      };

      const record = LeadMapper.normalize(raw, 'CAMP-001', TEST_SECRET);

      expect(record.campaign_id).toBe('CAMP-001');
      expect(record.voucher_code).toBe('VOUCHER-123');
      expect(record.status).toBe('Ativo');
      
      const expectedHmac = computeLeadEmailHmac('test@lead.com', TEST_SECRET);
      expect(record.email_hmac).toBe(expectedHmac);

      // Verify no raw PII in LeadRecord
      expect((record as any).email).toBeUndefined();
      expect((record as any).nome).toBeUndefined();
      expect((record as any).telefone).toBeUndefined();
      expect((record as any).cpf).toBeUndefined();
      expect((record as any).id_lead).toBeUndefined(); // removed dependence
    });

    it('missing email -> mapping failure', () => {
      const raw = { voucher: 'VOUCHER-123', status: 'Ativo' }; // No email
      expect(() => LeadMapper.normalize(raw, 'CAMP-001', TEST_SECRET))
        .toThrow('Lead missing required email for HMAC derivation');
    });

    it('empty email -> mapping failure', () => {
      const raw = { voucher: 'VOUCHER-123', email: '   ', status: 'Ativo' };
      expect(() => LeadMapper.normalize(raw, 'CAMP-001', TEST_SECRET))
        .toThrow('Lead missing required email for HMAC derivation');
    });

    it('campaign context required', () => {
      const raw = { voucher: 'VOUCHER-123', email: 'test@lead.com' };
      expect(() => LeadMapper.normalize(raw, '', TEST_SECRET))
        .toThrow('Campaign context is required');
    });

    it('voucher code required', () => {
      const raw = { email: 'test@lead.com' };
      expect(() => LeadMapper.normalize(raw, 'CAMP-001', TEST_SECRET))
        .toThrow('Lead missing required voucher_code identifier');
    });

    it('same campaign + voucher + email_hmac -> same natural key', () => {
      const raw1 = { voucher: 'V-1', email: 'a@test.com' };
      const raw2 = { vouchercode: 'V-1', email: ' A@TEST.com ' }; // aliases/variants

      const rec1 = LeadMapper.normalize(raw1, 'CAMP-1', TEST_SECRET);
      const rec2 = LeadMapper.normalize(raw2, 'CAMP-1', TEST_SECRET);

      expect(rec1.campaign_id).toBe(rec2.campaign_id);
      expect(rec1.voucher_code).toBe(rec2.voucher_code);
      expect(rec1.email_hmac).toBe(rec2.email_hmac);
    });

    it('same voucher + different email_hmac -> distinct Lead events', () => {
      const raw1 = { voucher: 'V-1', email: 'a@test.com' };
      const raw2 = { voucher: 'V-1', email: 'b@test.com' };

      const rec1 = LeadMapper.normalize(raw1, 'CAMP-1', TEST_SECRET);
      const rec2 = LeadMapper.normalize(raw2, 'CAMP-1', TEST_SECRET);

      expect(rec1.email_hmac).not.toBe(rec2.email_hmac);
    });

    it('same email + different voucher -> distinct Lead events', () => {
      const raw1 = { voucher: 'V-1', email: 'a@test.com' };
      const raw2 = { voucher: 'V-2', email: 'a@test.com' };

      const rec1 = LeadMapper.normalize(raw1, 'CAMP-1', TEST_SECRET);
      const rec2 = LeadMapper.normalize(raw2, 'CAMP-1', TEST_SECRET);

      expect(rec1.voucher_code).not.toBe(rec2.voucher_code);
    });
  });
});
