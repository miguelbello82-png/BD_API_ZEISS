import { isValidCnpj } from '../../../src/core/CnpjValidator';

describe('CnpjValidator (Modulo 11 Brazilian Algorithm)', () => {
  it('should accept valid 14-digit CNPJs', () => {
    // Official test CNPJs with correct verification digits
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('00.000.000/0001-91')).toBe(true);
    expect(isValidCnpj('04.288.966/0001-27')).toBe(true);
  });

  it('should reject CNPJs with invalid first check digit', () => {
    // Expected 8, but given 7
    expect(isValidCnpj('11222333000171')).toBe(false);
  });

  it('should reject CNPJs with invalid second check digit', () => {
    // Expected 1, but given 2
    expect(isValidCnpj('11222333000182')).toBe(false);
  });

  it('should reject repeating identical digits', () => {
    expect(isValidCnpj('00000000000000')).toBe(false);
    expect(isValidCnpj('11111111111111')).toBe(false);
    expect(isValidCnpj('99999999999999')).toBe(false);
  });

  it('should reject CNPJs with length different than 14 digits', () => {
    expect(isValidCnpj('')).toBe(false);
    expect(isValidCnpj('123')).toBe(false);
    expect(isValidCnpj('1122233300018')).toBe(false);
    expect(isValidCnpj('112223330001810')).toBe(false);
  });

  it('should reject non-numeric characters after sanitization if length != 14', () => {
    expect(isValidCnpj('abc-def')).toBe(false);
    expect(isValidCnpj('null')).toBe(false);
  });
});
