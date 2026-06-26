import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

/**
 * Resuelve la clave de cifrado en CADA llamada (no como const de módulo).
 * Así, tras un setup que recién genera y persiste ENCRYPTION_KEY en process.env,
 * los cifrados posteriores usan la clave definitiva. Antes se ligaba `KEY` al
 * importar el módulo: en modo setup era `Buffer.alloc(32)` (ceros) y la 1ª cuenta
 * quedaba irrecuperable al reiniciar (H-CRYPTO-SETUP). Lanza si no hay clave
 * válida — nunca cifra con una clave por defecto.
 */
function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (hex === undefined || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(
      'ENCRYPTION_KEY ausente o inválida: se requieren 64 caracteres hex (32 bytes) para cifrar/descifrar credenciales'
    );
  }
  return Buffer.from(hex, 'hex');
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encrypt(plain: string): EncryptedPayload {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let ciphertext = cipher.update(plain, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return {
    ciphertext,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

export function decrypt(payload: EncryptedPayload): string {
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  let plaintext = decipher.update(payload.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');
  return plaintext;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** HMAC-SHA256 del dato con JWT_SECRET como clave (firma de envelopes, p.ej. refresh tokens). */
export function hmacToken(data: string): string {
  const secret = process.env.JWT_SECRET ?? '';
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** Comparación en tiempo constante de dos HMAC hex (evita timing attacks).
 *  Valida que `mac` sea 64-hex ANTES de comparar: si no, `Buffer.from(mac,'hex')`
 *  podría diferir en bytes y `timingSafeEqual` lanzaría (→ 500 en vez de 401). */
export function verifyHmac(data: string, mac: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(mac)) return false;
  const expected = hmacToken(data);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mac, 'hex'));
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
