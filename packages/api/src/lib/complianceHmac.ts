import crypto from 'crypto';

/**
 * Evidencia tamper-evident de aceptación (DESIGN v4 §2.3, C-M1/M2/D-029).
 *
 * - **Canónico no ambiguo**: cada campo se serializa como `<longitud>:<valor>` (length-prefix) y se
 *   concatena en ORDEN FIJO. Evita colisiones cuando un valor (p.ej. `userAgent`) contiene los
 *   delimitadores habituales (`|`, `;`).
 * - **Secreto dedicado y rotación**: `COMPLIANCE_HMAC_SECRET` (NO se deriva de `JWT_SECRET`, que rota).
 *   Cada registro guarda `hmacKeyId`; las claves retiradas se archivan vía `COMPLIANCE_HMAC_RETIRED_KEYS`
 *   (JSON `{ keyId: secret }`) → la evidencia histórica siempre se puede verificar tras una rotación.
 */

export interface EvidenceFields {
  tenantId: string;
  userId: string;
  documentKey: string;
  versionId: string;
  version: number;
  contentHash: string;
  acceptedAt: string; // ISO-UTC
  ip: string;
  userAgent: string;
  method: string;
  locale: string;
}

// Orden FIJO de los campos en el canónico (no alterar sin versionar el esquema).
const FIELD_ORDER: (keyof EvidenceFields)[] = [
  'tenantId',
  'userId',
  'documentKey',
  'versionId',
  'version',
  'contentHash',
  'acceptedAt',
  'ip',
  'userAgent',
  'method',
  'locale',
];

/**
 * Serialización canónica determinista con length-prefix por campo. El prefijo es la longitud en
 * BYTES UTF-8 (no unidades UTF-16 de `String.length`) → reproducible cross-language al verificar
 * evidencia antigua desde otro stack (B P0c LOW).
 */
export function canonicalEvidence(fields: EvidenceFields): string {
  return FIELD_ORDER.map((k) => {
    const v = String(fields[k]);
    return `${String(Buffer.byteLength(v, 'utf8'))}:${v}`;
  }).join('|');
}

// Etiqueta `info` de HKDF: ata la clave derivada a este uso concreto. Aunque el ikm sea JWT_SECRET
// (fallback), la clave HMAC resultante es CRIPTOGRÁFICAMENTE DISTINTA de la usada para firmar JWT.
const HKDF_INFO = 'bifrost-compliance-evidence-hmac-v1';

/** Deriva la clave HMAC dedicada del secreto vía HKDF-SHA256 (DESIGN §2.3, C-M2 / D-006). */
function deriveKey(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), HKDF_INFO, 32));
}

/** keyId estable derivado de la clave HKDF (cambia si cambia el secreto → detecta rotación). */
function keyIdFor(secret: string): string {
  return crypto.createHash('sha256').update(deriveKey(secret)).digest('hex').slice(0, 16);
}

/**
 * Secreto actual de firma. En PRODUCCIÓN se EXIGE `COMPLIANCE_HMAC_SECRET` dedicado (B P0c MEDIUM):
 * la evidencia legal no debe depender de `JWT_SECRET`, que rota por seguridad y dejaría el histórico
 * sin verificar. Sólo en dev/test se permite el fallback a `JWT_SECRET` (vía HKDF, clave distinta).
 */
function currentSecret(): string {
  const dedicated = process.env.COMPLIANCE_HMAC_SECRET;
  if (dedicated && dedicated.length >= 32) return dedicated;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'COMPLIANCE_HMAC_SECRET es obligatorio en producción (≥32 chars): la evidencia de compliance ' +
        'no debe firmarse con JWT_SECRET (que rota). Configure un secreto dedicado.'
    );
  }
  const jwt = process.env.JWT_SECRET;
  if (jwt && jwt.length >= 32) {
    // Fallback SÓLO dev/test: HKDF lo convierte en una clave dedicada distinta de la de JWT.
    return jwt;
  }
  throw new Error(
    'COMPLIANCE_HMAC_SECRET ausente y JWT_SECRET no disponible: no se puede firmar evidencia de compliance'
  );
}

/** Registro de claves retiradas (para verificar evidencia firmada antes de una rotación). */
function retiredKeys(): Record<string, string> {
  const raw = process.env.COMPLIANCE_HMAC_RETIRED_KEYS;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // D-009: sólo se aceptan valores string; un entry malformado se ignora (no rompe la verificación).
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    // JSON inválido → se ignora (no se rompe la firma actual).
  }
  return {};
}

function hmacHex(key: Buffer, message: string): string {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

export function currentKeyId(): string {
  return keyIdFor(currentSecret());
}

/** Firma la evidencia con la clave actual. Devuelve el keyId para persistirlo en el registro. */
export function signEvidence(fields: EvidenceFields): { hmacKeyId: string; evidenceHmac: string } {
  const secret = currentSecret();
  return {
    hmacKeyId: keyIdFor(secret),
    evidenceHmac: hmacHex(deriveKey(secret), canonicalEvidence(fields)),
  };
}

/**
 * Verifica una evidencia firmada. Resuelve el secreto por `hmacKeyId`:
 * - si coincide con la clave actual → la usa;
 * - si no, busca en el registro de claves retiradas por keyId.
 * Comparación en tiempo constante.
 */
export function verifyEvidence(
  fields: EvidenceFields,
  hmacKeyId: string,
  evidenceHmac: string
): boolean {
  let secret: string | undefined;
  try {
    const cur = currentSecret();
    if (keyIdFor(cur) === hmacKeyId) secret = cur;
  } catch {
    secret = undefined;
  }
  if (!secret) {
    const retired = retiredKeys();
    for (const candidate of Object.values(retired)) {
      if (keyIdFor(candidate) === hmacKeyId) {
        secret = candidate;
        break;
      }
    }
  }
  if (!secret) return false;
  const expected = hmacHex(deriveKey(secret), canonicalEvidence(fields));
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(evidenceHmac, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Hash canónico del contenido (DESIGN §2.2): markdown fuente, todas las locales, sin bodyHtml. */
export function computeContentHash(
  contents: { locale: string; title: string; bodyMarkdown: string }[]
): string {
  const sorted = [...contents]
    .map((c) => ({ locale: c.locale, title: c.title, bodyMarkdown: c.bodyMarkdown }))
    .sort((x, y) => x.locale.localeCompare(y.locale));
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
