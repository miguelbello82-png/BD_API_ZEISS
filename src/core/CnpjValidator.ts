// ============================================================
// CNPJ Validator — BD_API_ZEISS Platform
// ============================================================
// Implements the canonical Brazilian Federal Revenue (Receita Federal)
// CNPJ verification algorithm (modulo 11 check digits).
// ============================================================

export function isValidCnpj(cnpj: string): boolean {
  if (!cnpj || typeof cnpj !== 'string') return false;

  // Clean non-numeric characters
  const clean = cnpj.replace(/\D/g, '');

  // Must have exactly 14 digits
  if (clean.length !== 14) return false;

  // Reject known invalid sequences (all same digits)
  if (/^(\d)\1{13}$/.test(clean)) return false;

  // Calculate first check digit
  const multipliers1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum1 = 0;
  for (let i = 0; i < 12; i++) {
    sum1 += parseInt(clean.charAt(i), 10) * multipliers1[i];
  }
  const remainder1 = sum1 % 11;
  const digit1 = remainder1 < 2 ? 0 : 11 - remainder1;

  if (digit1 !== parseInt(clean.charAt(12), 10)) {
    return false;
  }

  // Calculate second check digit
  const multipliers2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum2 = 0;
  for (let i = 0; i < 13; i++) {
    sum2 += parseInt(clean.charAt(i), 10) * multipliers2[i];
  }
  const remainder2 = sum2 % 11;
  const digit2 = remainder2 < 2 ? 0 : 11 - remainder2;

  return digit2 === parseInt(clean.charAt(13), 10);
}
