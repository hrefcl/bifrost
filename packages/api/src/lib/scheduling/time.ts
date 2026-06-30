import { DateTime, IANAZone } from 'luxon';

/**
 * Helpers de zona horaria / DST para el motor de agenda.
 *
 * El bug nº1 de los sistemas de scheduling es el off-by-one-hour en transiciones DST. El backend no
 * tenía librería de fechas (sólo `Date`), así que se sumó `luxon` (review B HIGH) y aquí vive el
 * RESOLVER EXPLÍCITO de wall-time → UTC que B condicionó para aprobar el diseño:
 *
 *  - GAP (spring-forward): una hora local que NO existe (p.ej. 02:30 el día que el reloj salta 02→03).
 *    Ningún offset la mapea de vuelta → se OMITE (`{ skip:'nonexistent' }`); el caller no genera ese slot.
 *  - AMBIGÜEDAD (fall-back): una hora local que ocurre DOS veces (p.ej. 01:30 el día que el reloj
 *    retrocede 02→01). Se toma la PRIMERA ocurrencia = MENOR instante UTC (determinista, documentado).
 *
 * Algoritmo: se enumeran los offsets candidatos alrededor del instante (sondeando ±2h para cubrir
 * ambos lados de una transición), se construye el instante UTC para cada uno y se VALIDA por round-trip
 * que re-mapea exactamente a la misma hora de pared. Cero candidatos válidos ⇒ gap. Varios ⇒ ambigüedad.
 */

export type WallTimeResolution = { utc: Date } | { skip: 'nonexistent' };

/** ¿Es `zone` un identificador IANA válido (p.ej. "America/Santiago")? */
export function isValidZone(zone: string): boolean {
  return typeof zone === 'string' && zone.length > 0 && IANAZone.isValidZone(zone);
}

function parseInts(parts: string[]): number[] {
  return parts.map((p) => Number(p));
}

/**
 * Resuelve una hora de pared (`dateISO` = "YYYY-MM-DD", `hhmm` = "HH:MM") en la zona `zone` al
 * instante UTC correcto, manejando DST. Ver doc del módulo para la semántica de gap/ambigüedad.
 * Lanza si los argumentos no son parseables o la zona es inválida.
 */
export function resolveWallTime(dateISO: string, hhmm: string, zone: string): WallTimeResolution {
  if (!isValidZone(zone)) throw new Error(`resolveWallTime: invalid IANA zone "${zone}"`);
  // Formato ESTRICTO: sin esto, partes extra se ignorarían silenciosamente ("10:00:30"→"10:00",
  // "2026-01-01-x" pasaría) — review B. Exigimos exactamente YYYY-MM-DD y HH:MM.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    throw new Error(`resolveWallTime: date must be YYYY-MM-DD, got "${dateISO}"`);
  }
  if (!/^\d{2}:\d{2}$/.test(hhmm)) {
    throw new Error(`resolveWallTime: time must be HH:MM, got "${hhmm}"`);
  }
  const [year, month, day] = parseInts(dateISO.split('-'));
  const [hour, minute] = parseInts(hhmm.split(':'));
  // Validación ESTRICTA de rango. Sin esto, una hora fuera de rango (p.ej. "24:00" como fin de
  // intervalo, o "25:00") NO lanzaría: `Date.UTC` la desbordaría al día siguiente y el round-trip
  // fallaría → devolvería `{skip:'nonexistent'}` SILENCIOSO (resultado incorrecto, no error). El
  // caller del motor de slots debe normalizar el "fin de día 24:00" a 00:00 del día siguiente ANTES
  // de resolver — esta primitiva exige `hour∈[0,23]`, `minute∈[0,59]` (auto-auditoría / hardening).
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(`resolveWallTime: out-of-range date/time "${dateISO} ${hhmm}"`);
  }
  // Validez de CALENDARIO (rechaza 2026-02-31, 2026-04-31, etc.) ANTES de la resolución DST, para NO
  // confundir input inválido con un gap real (review B). Se valida en UTC a propósito: la existencia
  // de la FECHA no depende de la zona → así NO damos falso positivo en zonas con gap a medianoche
  // (p.ej. Santiago, donde 00:00 de un día puede no existir, pero la fecha sí es válida).
  const cal = DateTime.utc(year, month, day);
  if (!cal.isValid || cal.year !== year || cal.month !== month || cal.day !== day) {
    throw new Error(`resolveWallTime: invalid calendar date "${dateISO}"`);
  }

  // Offsets candidatos: el del propio instante + los de ±2h (capturan ambos lados de una transición).
  const at = (deltaHours: number): number =>
    DateTime.fromObject({ year, month, day, hour, minute }, { zone }).plus({ hours: deltaHours })
      .offset; // minutos respecto a UTC (este de UTC = positivo)
  const offsets = new Set<number>([at(0), at(-2), at(2)]);

  // Para cada offset candidato: UTC = wall − offset; validamos por round-trip a la zona.
  const candidates: number[] = [];
  const wallAsUtcMillis = Date.UTC(year, month - 1, day, hour, minute);
  for (const offsetMin of offsets) {
    const utcMillis = wallAsUtcMillis - offsetMin * 60_000;
    const back = DateTime.fromMillis(utcMillis, { zone });
    if (
      back.isValid &&
      back.year === year &&
      back.month === month &&
      back.day === day &&
      back.hour === hour &&
      back.minute === minute
    ) {
      candidates.push(utcMillis);
    }
  }

  if (candidates.length === 0) return { skip: 'nonexistent' }; // gap: la hora local no existe
  // Ambigüedad fall-back → primera ocurrencia = menor instante UTC.
  return { utc: new Date(Math.min(...candidates)) };
}

/** Día-calendario (YYYY-MM-DD) de un instante UTC en la zona del host. Para agrupar dailyLimit. */
export function hostCalendarDay(instant: Date, zone: string): string {
  if (!isValidZone(zone)) throw new Error(`hostCalendarDay: invalid IANA zone "${zone}"`);
  return DateTime.fromJSDate(instant, { zone }).toFormat('yyyy-MM-dd');
}
