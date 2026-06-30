import { SystemConfig } from '../../models/SystemConfig.js';
import type { MeetSettings } from '@webmail6/shared';

/**
 * Config de Bifrost Meet — singleton en `SystemConfig` (key='meet'), MISMO patrón que
 * scheduling/branding (no crear colección singleton nueva). `getMeetSettings` devuelve DEFAULTS si el
 * doc no existe; `setMeetSettings` hace upsert con merge defensivo.
 *
 * Gate `enabled=false`: apaga TODA la feature (endpoints responden disabled/404). El gate efectivo
 * (`meetEnabled()`) además exige que las credenciales LIVEKIT_* estén presentes — ver token-service.
 */
const KEY = 'meet';

export const DEFAULT_MEET_SETTINGS: MeetSettings = {
  enabled: false, // arranca APAGADA: se activa desde el admin (y requiere LIVEKIT_* en el entorno).
  wsUrl: '',
  publicBaseUrl: '',
  maxParticipants: 20,
  maxDurationMinutes: 240,
  allowExternal: true,
  auditEnabled: true,
  recordingPolicy: 'disabled',
};

export async function getMeetSettings(): Promise<MeetSettings> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean<{
    value?: Partial<MeetSettings>;
  } | null>();
  const v = doc?.value ?? {};
  const out: MeetSettings = {
    enabled: v.enabled ?? DEFAULT_MEET_SETTINGS.enabled,
    // Defaults de entorno: si el admin no fijó wsUrl/publicBaseUrl, se toman del env (deploy-time).
    wsUrl: v.wsUrl ?? process.env.LIVEKIT_WS_URL ?? DEFAULT_MEET_SETTINGS.wsUrl,
    publicBaseUrl:
      v.publicBaseUrl ?? process.env.MEET_PUBLIC_BASE_URL ?? DEFAULT_MEET_SETTINGS.publicBaseUrl,
    maxParticipants: v.maxParticipants ?? DEFAULT_MEET_SETTINGS.maxParticipants,
    maxDurationMinutes: v.maxDurationMinutes ?? DEFAULT_MEET_SETTINGS.maxDurationMinutes,
    allowExternal: v.allowExternal ?? DEFAULT_MEET_SETTINGS.allowExternal,
    auditEnabled: v.auditEnabled ?? DEFAULT_MEET_SETTINGS.auditEnabled,
    recordingPolicy: 'disabled',
  };
  if (v.turnDomain) out.turnDomain = v.turnDomain;
  if (v.branding) out.branding = v.branding;
  return out;
}

export type MeetSettingsPatch = Partial<MeetSettings>;

export async function setMeetSettings(patch: MeetSettingsPatch): Promise<MeetSettings> {
  const current = await getMeetSettings();
  // `recordingPolicy` es inmutable en MVP (siempre 'disabled') — no se acepta por patch.
  const { recordingPolicy: _ignored, ...rest } = patch;
  const value: MeetSettings = { ...current, ...rest, recordingPolicy: 'disabled' };
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}
