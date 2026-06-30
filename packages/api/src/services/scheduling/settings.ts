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
  return {
    enabled: v.enabled ?? DEFAULT_SCHEDULING_SETTINGS.enabled,
    publicLinksEnabled: v.publicLinksEnabled ?? DEFAULT_SCHEDULING_SETTINGS.publicLinksEnabled,
    defaults: {
      timezone: v.defaults?.timezone ?? DEFAULT_SCHEDULING_SETTINGS.defaults.timezone,
      durationMinutes:
        v.defaults?.durationMinutes ?? DEFAULT_SCHEDULING_SETTINGS.defaults.durationMinutes,
      dateRangeDays:
        v.defaults?.dateRangeDays ?? DEFAULT_SCHEDULING_SETTINGS.defaults.dateRangeDays,
    },
    maxEventTypesPerUser: v.maxEventTypesPerUser,
    auditEnabled: v.auditEnabled ?? DEFAULT_SCHEDULING_SETTINGS.auditEnabled,
  };
}

export async function setSchedulingSettings(
  patch: Partial<SchedulingSettings>
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
