import { SystemConfig } from '../models/SystemConfig.js';
import type { CalendarSettings } from '@webmail6/shared';

/**
 * Defaults de calendario a nivel instancia (admin) — singleton en `SystemConfig` (key='calendarDefaults'),
 * MISMO patrón que scheduling/branding/storage. `getCalendarSettings` hace DEEP-MERGE con los defaults
 * (un doc viejo sin todas las claves no rompe — review C); `setCalendarSettings` valida y hace upsert.
 */
const KEY = 'calendarDefaults';

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  timezone: 'America/Santiago',
  weekStart: 1,
  dayStart: '08:00',
  dayEnd: '20:00',
  defaultDurationMin: 30,
  defaultView: 'week',
  showWeekends: true,
  autoInvite: true,
  syncAgenda: true,
};

export async function getCalendarSettings(): Promise<CalendarSettings> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean<{
    value?: Partial<CalendarSettings>;
  } | null>();
  const v = doc?.value ?? {};
  const d = DEFAULT_CALENDAR_SETTINGS;
  // Deep-merge defensivo clave por clave: un doc parcial mantiene los defaults de lo ausente.
  return {
    timezone: v.timezone ?? d.timezone,
    weekStart: v.weekStart ?? d.weekStart,
    dayStart: v.dayStart ?? d.dayStart,
    dayEnd: v.dayEnd ?? d.dayEnd,
    defaultDurationMin: v.defaultDurationMin ?? d.defaultDurationMin,
    defaultView: v.defaultView ?? d.defaultView,
    showWeekends: v.showWeekends ?? d.showWeekends,
    autoInvite: v.autoInvite ?? d.autoInvite,
    syncAgenda: v.syncAgenda ?? d.syncAgenda,
  };
}

/** Error de validación de la config de calendario → el router lo mapea a 400. */
export class CalendarSettingsError extends Error {}

/** Patch PARCIAL (se mergea contra el actual). */
export type CalendarSettingsPatch = Partial<CalendarSettings>;

export async function setCalendarSettings(patch: CalendarSettingsPatch): Promise<CalendarSettings> {
  const current = await getCalendarSettings();
  const value: CalendarSettings = { ...current, ...patch };
  // Validar el invariante sobre el VALOR MERGEADO con ESTA misma lectura (review B-MED): si la
  // validación viviera sólo en el router (con otra lectura de `current`), dos PATCH parciales
  // concurrentes podrían persistir `dayEnd <= dayStart`. Aquí el merge y la validación comparten la
  // misma `current` → cada guardado valida su propio resultado (HH:MM zero-padded → compara léxico).
  if (value.dayEnd <= value.dayStart) {
    throw new CalendarSettingsError('El fin de jornada debe ser posterior al inicio');
  }
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}
