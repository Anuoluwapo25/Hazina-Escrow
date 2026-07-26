import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const SEPARATOR = ':';

function getKey(): Buffer {
  const raw = process.env.WEBHOOK_SECRET_KEY ?? '';
  if (!raw) {
    throw new Error(
      'WEBHOOK_SECRET_KEY env var is not set — cannot encrypt/decrypt webhook secrets',
    );
  }
  if (raw.length !== 64) {
    throw new Error('WEBHOOK_SECRET_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(raw, 'hex');
}

/**
 * Encrypts a webhook secret with AES-256-GCM.
 * Returns `iv:authTag:ciphertext` (all hex) for storage.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(SEPARATOR);
}

/**
 * Decrypts a stored webhook secret.
 * Handles legacy plaintext values (those not in `iv:authTag:ciphertext` format)
 * by returning them as-is so existing subscriptions remain functional.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split(SEPARATOR);
  if (parts.length !== 3) {
    // Legacy plaintext — not yet encrypted; return verbatim
    return stored;
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  if (!ivHex || !authTagHex || !ciphertextHex) {
    return stored;
  }
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}
