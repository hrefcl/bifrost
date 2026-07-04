import { SystemConfig } from '../../models/SystemConfig.js';
import { encrypt, type EncryptedPayload } from '../../config/crypto.js';

/**
 * Credenciales del cliente OAuth de Google configurables desde /admin (F-gcal admin-config). Singleton en
 * `SystemConfig` (key='googleCalendar'). El client secret se guarda CIFRADO at-rest (mismo patrón que
 * Meet/S3, `config/crypto.ts`) y NUNCA sale por la API (ni el plano ni el ciphertext). Este módulo persiste
 * el doc TAL CUAL (sin merge con env): la decisión DB-o-env vive ATÓMICAMENTE en `creds.ts` (review B/D:
 * no mezclar campos DB+env acá).
 */
const KEY = 'googleCalendar';

/** Forma PERSISTIDA (interna). El client secret CIFRADO — jamás sale por la API. */
export interface StoredGoogleConfig {
  clientId?: string;
  clientSecretEnc?: EncryptedPayload;
  redirectUri?: string;
}

/** Lee el doc de SystemConfig CRUDO (sin merge con env). Devuelve `{}` si no hay doc. */
export async function getRawGoogleConfig(): Promise<StoredGoogleConfig> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean<{
    value?: Partial<StoredGoogleConfig>;
  } | null>();
  const v = doc?.value ?? {};
  const out: StoredGoogleConfig = {};
  if (v.clientId) out.clientId = v.clientId;
  if (v.clientSecretEnc) out.clientSecretEnc = v.clientSecretEnc;
  if (v.redirectUri) out.redirectUri = v.redirectUri;
  return out;
}

/**
 * PATCH del admin. Semántica por campo (review D): `undefined`/omitido = PRESERVA; `''` = CLEAR (borra ese
 * campo → si el trío deja de estar completo, cae a env); `<valor>` = SET. Para `clientSecret`: `''` borra el
 * cifrado, `<valor>` cifra y guarda. El plano se STRIPA (nunca se persiste sin cifrar).
 */
export interface GoogleConfigPatch {
  clientId?: string;
  redirectUri?: string;
  clientSecret?: string;
}

export async function setGoogleConfig(patch: GoogleConfigPatch): Promise<void> {
  const current = await getRawGoogleConfig();
  const value: StoredGoogleConfig = { ...current };

  if (patch.clientId !== undefined) {
    const v = patch.clientId.trim();
    if (v === '') delete value.clientId;
    else value.clientId = v;
  }
  if (patch.redirectUri !== undefined) {
    const v = patch.redirectUri.trim();
    if (v === '') delete value.redirectUri;
    else value.redirectUri = v;
  }
  if (patch.clientSecret === '') {
    delete value.clientSecretEnc; // CLEAR
  } else if (patch.clientSecret !== undefined) {
    value.clientSecretEnc = encrypt(patch.clientSecret); // SET (cifrado)
  }

  // ACOPLE (molde Meet, review B MED): el secret no puede quedar HUÉRFANO. Si tras el patch falta el
  // clientId o el redirectUri, se descarta el secret cifrado — no tiene sentido guardarlo sin el trío
  // (caería a env y confundiría al admin con un hasClientSecret:true inservible).
  if (value.clientSecretEnc && (!value.clientId || !value.redirectUri)) {
    delete value.clientSecretEnc;
  }

  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  // La invalidación del cache la hace el caller (ruta admin) para no acoplar settings.ts ↔ creds.ts.
}
