import { SystemConfig } from '../../models/SystemConfig.js';
import { encrypt, type EncryptedPayload } from '../../config/crypto.js';

/**
 * Config de Bifrost Meet — singleton en `SystemConfig` (key='meet'). El secret de LiveKit se guarda
 * CIFRADO at-rest (mismo patrón que Account/S3, `config/crypto.ts`) y vive en el tipo INTERNO
 * `StoredMeetSettings` — NUNCA sale por la API (ni el plano ni el ciphertext). El DTO admin (allowlist,
 * `toAdminMeetSettings` en routes) expone solo `hasApiSecret`+`livekitSource`. (review F3.7 B/C/D-M3.)
 */
const KEY = 'meet';

/** Forma PERSISTIDA (interna del API). Incluye el secret CIFRADO. */
export interface StoredMeetSettings {
  enabled: boolean;
  wsUrl: string;
  publicBaseUrl: string;
  turnDomain?: string;
  maxParticipants: number;
  maxDurationMinutes: number;
  allowExternal: boolean;
  branding?: { displayName?: string };
  auditEnabled: boolean;
  // LiveKit externo/Cloud (F3.7):
  livekitApiKey?: string;
  livekitApiSecretEnc?: EncryptedPayload; // SECRET cifrado — jamás sale por la API.
  livekitApiUrl?: string;
  region?: string;
  maxResolution?: '720p' | '1080p';
  autoRecord?: boolean;
  onDemand?: boolean;
}

export const DEFAULT_STORED_MEET_SETTINGS: StoredMeetSettings = {
  enabled: false,
  wsUrl: '',
  publicBaseUrl: '',
  maxParticipants: 20,
  maxDurationMinutes: 240,
  allowExternal: true,
  auditEnabled: true,
};

/**
 * Default del interruptor maestro `enabled` cuando el admin NUNCA lo fijó en la DB (TD-MEET-PROVISION-ENABLED).
 * Turnkey: si el deploy fue **provisionado** para Meet (`MEET_PROVISIONED` seteado por el provisioner al
 * elegir `--enable-meet`), Meet arranca ENCENDIDO — el operador no tiene que hacer un PATCH extra. Sin
 * provisionar, arranca apagado. Un `enabled` EXPLÍCITO en la DB (true o false) SIEMPRE manda sobre esto
 * (el admin puede apagar Meet en un box provisionado). `meetEnabled` igual gatea por creds+wsUrl, así que
 * esto solo afecta el default del flag, no la seguridad.
 *
 * Nota (review C-F3.5b): el primer PATCH que OMITA `enabled` materializa este default a `enabled:true`
 * en la DB (el merge `{...current}` lee el default provisionado) → a partir de ahí queda explícito.
 * No es bug: es el mismo patrón turnkey ya existente para `wsUrl`/env; el admin retiene control con
 * `PATCH enabled:false`.
 */
function provisionedEnabledDefault(): boolean {
  return (process.env.MEET_PROVISIONED ?? '').trim().length > 0;
}

/**
 * Lee la config persistida (interna, con el secret cifrado). `wsUrl`/`publicBaseUrl` defaultean al env
 * (deploy-time) si el admin no los fijó. Devuelve SIEMPRE un objeto válido (defaults si no hay doc).
 */
export async function getStoredMeetSettings(): Promise<StoredMeetSettings> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean<{
    value?: Partial<StoredMeetSettings>;
  } | null>();
  const v = doc?.value ?? {};
  const out: StoredMeetSettings = {
    // Sin valor explícito en DB: ON si el deploy fue provisionado para Meet (turnkey), OFF si no.
    enabled: v.enabled ?? provisionedEnabledDefault(),
    wsUrl: v.wsUrl ?? process.env.LIVEKIT_WS_URL ?? DEFAULT_STORED_MEET_SETTINGS.wsUrl,
    publicBaseUrl:
      v.publicBaseUrl ??
      process.env.MEET_PUBLIC_BASE_URL ??
      DEFAULT_STORED_MEET_SETTINGS.publicBaseUrl,
    maxParticipants: v.maxParticipants ?? DEFAULT_STORED_MEET_SETTINGS.maxParticipants,
    maxDurationMinutes: v.maxDurationMinutes ?? DEFAULT_STORED_MEET_SETTINGS.maxDurationMinutes,
    allowExternal: v.allowExternal ?? DEFAULT_STORED_MEET_SETTINGS.allowExternal,
    auditEnabled: v.auditEnabled ?? DEFAULT_STORED_MEET_SETTINGS.auditEnabled,
  };
  if (v.turnDomain) out.turnDomain = v.turnDomain;
  if (v.branding) out.branding = v.branding;
  if (v.livekitApiKey) out.livekitApiKey = v.livekitApiKey;
  if (v.livekitApiSecretEnc) out.livekitApiSecretEnc = v.livekitApiSecretEnc;
  if (v.livekitApiUrl) out.livekitApiUrl = v.livekitApiUrl;
  if (v.region) out.region = v.region;
  if (v.maxResolution) out.maxResolution = v.maxResolution;
  if (typeof v.autoRecord === 'boolean') out.autoRecord = v.autoRecord;
  if (typeof v.onDemand === 'boolean') out.onDemand = v.onDemand;
  return out;
}

/**
 * PATCH del admin. `livekitApiSecret` (PLANO) tiene 3 semánticas (review B/C/D-H3/R1):
 *  - OMITIDO  → preserva el secret cifrado actual.
 *  - `''`     → CLEAR: borra key+secret atómicamente → Meet vuelve a env-only.
 *  - `<valor>`→ SET: cifra y guarda. `livekitApiKey` se acopla (set/clear juntos).
 * `recordingPolicy` es inmutable (siempre 'disabled'). El plano del secret se STRIPA antes de persistir.
 */
export interface MeetSettingsPatch {
  enabled?: boolean;
  wsUrl?: string;
  publicBaseUrl?: string;
  turnDomain?: string;
  maxParticipants?: number;
  maxDurationMinutes?: number;
  allowExternal?: boolean;
  branding?: { displayName?: string };
  livekitApiKey?: string;
  livekitApiUrl?: string;
  region?: string;
  maxResolution?: '720p' | '1080p';
  autoRecord?: boolean;
  onDemand?: boolean;
  livekitApiSecret?: string;
}

export async function setMeetSettings(patch: MeetSettingsPatch): Promise<StoredMeetSettings> {
  const current = await getStoredMeetSettings();
  const { livekitApiSecret, ...rest } = patch; // STRIP del plano antes del merge
  const value: StoredMeetSettings = { ...current, ...rest };

  // CLEAR atómico (couple key+secret) si CUALQUIERA se vacía explícitamente — evita el estado huérfano
  // `secretEnc` sin key o key sin secret (review D-005). `''` en key o secret → ambos fuera → cae a env.
  const clearByKey = rest.livekitApiKey?.trim() === '';
  if (livekitApiSecret === '' || clearByKey) {
    delete value.livekitApiKey;
    delete value.livekitApiSecretEnc;
  } else if (livekitApiSecret !== undefined) {
    // SET: cifra el secret. La ruta valida que venga `livekitApiKey` (par completo).
    value.livekitApiSecretEnc = encrypt(livekitApiSecret);
  }
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}
