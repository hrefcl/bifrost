import { SystemConfig } from '../../models/SystemConfig.js';
import type { SchedulingSettings } from '@webmail6/shared';

/**
 * Config de empresa de la agenda — singleton en `SystemConfig` (key='scheduling'), MISMO patrón que
 * branding/storage (review B-LOW/D-020: no crear una colección singleton nueva). `getSchedulingSettings`
 * devuelve DEFAULTS si el doc no existe (sin race en first-read); `setSchedulingSettings` hace upsert.
 *
 * Gate `enabled=false`: apaga DESCUBRIMIENTO + nueva reserva, pero NO la gestión de reservas existentes
 * (cancel/reschedule por token) — eso lo aplica el router público en Fase 3.4 (review C-M9).
 */
const KEY = 'scheduling';

export const DEFAULT_SCHEDULING_SETTINGS: SchedulingSettings = {
  enabled: false, // la feature arranca APAGADA (review): se activa desde el admin.
  publicLinksEnabled: true,
  defaults: { timezone: 'America/Santiago', durationMinutes: 30, dateRangeDays: 60 },
  auditEnabled: true,
};

export async function getSchedulingSettings(): Promise<SchedulingSettings> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean<{
    value?: Partial<SchedulingSettings>;
  } | null>();
  const v = doc?.value ?? {};
  // Merge defensivo con los defaults (un doc viejo puede no tener todas las claves).
  const out: SchedulingSettings = {
    enabled: v.enabled ?? DEFAULT_SCHEDULING_SETTINGS.enabled,
    publicLinksEnabled: v.publicLinksEnabled ?? DEFAULT_SCHEDULING_SETTINGS.publicLinksEnabled,
    defaults: {
      timezone: v.defaults?.timezone ?? DEFAULT_SCHEDULING_SETTINGS.defaults.timezone,
      durationMinutes:
        v.defaults?.durationMinutes ?? DEFAULT_SCHEDULING_SETTINGS.defaults.durationMinutes,
      dateRangeDays:
        v.defaults?.dateRangeDays ?? DEFAULT_SCHEDULING_SETTINGS.defaults.dateRangeDays,
    },
    auditEnabled: v.auditEnabled ?? DEFAULT_SCHEDULING_SETTINGS.auditEnabled,
  };
  // `maxEventTypesPerUser` es OPCIONAL: sólo se incluye si es un número real. Mongo persiste un
  // `undefined` como `null`, y un `null` filtrado rompía el límite (`count >= null` → `count >= 0` →
  // siempre true, bloqueando TODA creación de tipos tras guardar settings). Omitir la clave si no es
  // número evita re-persistir null y normaliza el DTO. (Hallazgo E2E retry-robusto.)
  if (typeof v.maxEventTypesPerUser === 'number') {
    out.maxEventTypesPerUser = v.maxEventTypesPerUser;
  }
  return out;
}

/** Patch admite `defaults` PARCIAL (se mergea contra el actual) — no exige el objeto completo. */
export type SchedulingSettingsPatch = Partial<Omit<SchedulingSettings, 'defaults'>> & {
  defaults?: Partial<SchedulingSettings['defaults']>;
};

export async function setSchedulingSettings(
  patch: SchedulingSettingsPatch
): Promise<SchedulingSettings> {
  const current = await getSchedulingSettings();
  const value: SchedulingSettings = {
    ...current,
    ...patch,
    defaults: { ...current.defaults, ...(patch.defaults ?? {}) },
  };
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}
