import { createHmac } from 'node:crypto';

/**
 * Derivación del PASSWORD SMTP de Amazon SES a partir del SecretAccessKey de un IAM user.
 *
 * SES no usa el SecretAccessKey crudo como password SMTP: usa una derivación HMAC versionada
 * (documentada por AWS — "Obtaining Amazon SES SMTP credentials by converting existing AWS
 * credentials"). El username SMTP es el AccessKeyId tal cual; el password es lo que devuelve esta
 * función. Lo derivamos EN EL CLI (en memoria) para no mandar nunca el SecretAccessKey crudo al box:
 * al box sólo viaja este password (vía SSM SecureString). Ver docs/diseno-ses-turnkey.md (B-HIGH#1).
 *
 * Algoritmo (constantes fijas de AWS):
 *   date    = "11111111"   (literal, NO la fecha de hoy)
 *   service = "ses"
 *   message = "SendRawEmail"
 *   terminal= "aws4_request"
 *   version = 0x04
 *   k       = HMAC("AWS4"+secret, date) → HMAC(k, region) → HMAC(k, service) → HMAC(k, terminal)
 *             → HMAC(k, message)
 *   password= base64( version_byte || k )
 */
const SES_SMTP_VERSION = 0x04;

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Convierte un SecretAccessKey de IAM en el password SMTP de SES para una región dada.
 * @param secretAccessKey  el SecretAccessKey del IAM user (se usa sólo en memoria, no se persiste).
 * @param region           la región de SES (p.ej. "us-east-1") — el endpoint SMTP es por región.
 */
export function deriveSesSmtpPassword(secretAccessKey: string, region: string): string {
  if (!secretAccessKey) throw new Error('deriveSesSmtpPassword: secretAccessKey vacío');
  if (!region) throw new Error('deriveSesSmtpPassword: region vacía');

  // Encadenado SigV4 con la "fecha" literal 11111111 (así lo define AWS para esta derivación).
  let signature = hmac(`AWS4${secretAccessKey}`, '11111111');
  signature = hmac(signature, region);
  signature = hmac(signature, 'ses');
  signature = hmac(signature, 'aws4_request');
  signature = hmac(signature, 'SendRawEmail');

  // Prefijo de versión (0x04) + la firma → base64.
  return Buffer.concat([Buffer.from([SES_SMTP_VERSION]), signature]).toString('base64');
}

/** El host SMTP de SES para una región (submission STARTTLS en el 587). */
export function sesSmtpHost(region: string): string {
  if (!region) throw new Error('sesSmtpHost: region vacía');
  return `email-smtp.${region}.amazonaws.com`;
}
