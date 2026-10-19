import * as crypto from 'crypto';

/**
 * Normalizes an email for deterministic HMAC generation.
 * @param email The raw email string
 * @returns The normalized email string or an empty string if falsy
 */
export function normalizeLeadEmail(email: string | null | undefined): string {
  if (!email) return '';
  return String(email).trim().toLowerCase();
}

/**
 * Computes an HMAC-SHA256 hash for the normalized email.
 * @param normalizedEmail The normalized email string
 * @param secret The canonical HMAC secret
 * @returns The hex representation of the HMAC
 */
export function computeLeadEmailHmac(normalizedEmail: string, secret: string): string {
  if (!normalizedEmail) throw new Error('Email must be provided and normalized for HMAC computation');
  if (!secret) throw new Error('Secret must be provided for HMAC computation');
  
  return crypto.createHmac('sha256', secret).update(normalizedEmail).digest('hex');
}
