import { DateTime } from 'luxon';
import type { WeeklyRule, AvailabilityOverride } from '@webmail6/shared';
import { resolveWallTime, isValidZone } from './time.js';

/**
 * MOTOR DE SLOTS — funciones PURAS (sin red ni DB). El corazón algorítmico de la agenda.
 *
 * Principio clave (review C-H1): el MISMO predicado `isSlotBookable` se usa para (a) generar los slots
 * que ve el invitado y (b) re-validar bajo lock al confirmar. Así un slot mostrado desde una página
 * cacheada que ya no es válido (límite diario alcanzado, choque nuevo, fuera de anticipación) se
 * rechaza en el POST.
 *
 * DST: el tiling se hace por HORA DE PARED (09:00, 09:30, …) y cada candidato se resuelve a UTC con
 * `resolveWallTime` (que omite horas inexistentes de spring-forward y resuelve ambigüedades fall-back a
 * la primera ocurrencia). Así un slot que cae en el gap simplemente no se genera.
 */

const MIN = 60_000;

export interface BusyInterval {
  start: Date;
  end: Date;
  /** Buffers PROPIOS del ocupado (review B-HIGH): una reserva existente con bufferAfter exige ese
   * hueco DESPUÉS de ella aunque el candidato no tenga bufferBefore. El caller (3.4) los rellena
   * desde el snapshot de cada Booking; los eventos manuales del calendario van con 0. */
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
}

export interface SlotParams {
  durationMinutes: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minimumNoticeMin: number;
  dateRangeDays: number;
  /** Paso de la grilla; default = durationMinutes. */
  slotIncrementMin?: number;
  /** Máx reservas confirmadas por día del anfitrión. 0/undefined = sin límite. */
  dailyLimit?: number;
}

export interface ResolvedSchedule {
  timezone: string;
  weeklyRules: WeeklyRule[];
  overrides: AvailabilityOverride[];
}

// ── helpers de hora-de-pared ────────────────────────────────────────────────
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Intervalos de disponibilidad (en minutos-de-pared del día) para una fecha host-local "YYYY-MM-DD".
 * Una EXCEPCIÓN para esa fecha REEMPLAZA la regla semanal (review C-M10): `intervals:[]` = no disponible.
 * `weekday`: 0=Domingo … 6=Sábado (JS getDay). Un fin "24:00" se admite como minuto 1440 (fin de día).
 */
export function availabilityIntervalsForDate(
  dateISO: string,
  schedule: ResolvedSchedule
): { startMin: number; endMin: number }[] {
  const override = schedule.overrides.find((o) => o.date === dateISO);
  let raw: { start: string; end: string }[];
  if (override) {
    raw = override.intervals;
  } else {
    // weekday de la fecha en la tz del host.
    const weekday = DateTime.fromISO(dateISO, { zone: schedule.timezone }).weekday % 7; // luxon 1..7 (Mon..Sun) → 0..6 con 0=Dom
    const rule = schedule.weeklyRules.find((r) => r.weekday === weekday);
    raw = rule ? rule.intervals : [];
  }
  return raw
    .map((i) => ({
      startMin: hhmmToMinutes(i.start),
      endMin: i.end === '24:00' ? 1440 : hhmmToMinutes(i.end),
    }))
    .filter((i) => i.endMin > i.startMin);
}

/**
 * Resuelve el inicio de un slot (fecha host + minuto-de-pared) a un instante UTC. `null` si esa hora
 * local no existe (gap DST) → el caller omite ese candidato. Para el fin se usa `start + duración`
 * (la duración es tiempo REAL, no de pared).
 */
function resolveSlotStart(dateISO: string, startMin: number, tz: string): Date | null {
  const r = resolveWallTime(dateISO, minutesToHHMM(startMin), tz);
  return 'utc' in r ? r.utc : null;
}

/**
 * Instantes UTC candidatos de una hora-de-pared (mismas reglas que `resolveWallTime`: enumera offsets
 * sondeando ±2h y valida por round-trip). En una hora AMBIGUA (fall-back) devuelve los DOS instantes; en
 * una normal, uno; en un gap, ninguno.
 */
// NOTA (review D-065, LOW/tech-debt): comparte la lógica de enumeración de offsets con
// `resolveWallTime` (time.ts). Se mantiene local a propósito porque aquí se necesitan AMBOS instantes
// (lower/upper) sin la semántica de gap→skip; si esta enumeración cambia, revisar también time.ts.
function wallCandidatesMs(
  year: number,
  month: number,
  day: number,
  minute: number,
  tz: string
): number[] {
  const hour = Math.floor(minute / 60);
  const min = minute % 60;
  const at = (dh: number): number =>
    DateTime.fromObject({ year, month, day, hour, minute: min }, { zone: tz }).plus({ hours: dh })
      .offset;
  const offsets = new Set<number>([at(0), at(-2), at(2)]);
  const wallUtc = Date.UTC(year, month - 1, day, hour, min);
  const out: number[] = [];
  for (const off of offsets) {
    const ms = wallUtc - off * 60_000;
    const back = DateTime.fromMillis(ms, { zone: tz });
    if (
      back.year === year &&
      back.month === month &&
      back.day === day &&
      back.hour === hour &&
      back.minute === min
    ) {
      out.push(ms);
    }
  }
  return out;
}

/**
 * Instante UTC (ms) del LÍMITE de un intervalo (review B-HIGH: la contención se valida en tiempo REAL,
 * no en minutos-de-pared). `kind`: 'lower' (inicio del intervalo) toma la ocurrencia MÁS TEMPRANA;
 * 'upper' (fin) la MÁS TARDÍA — así, en una transición fall-back con un borde ambiguo, el intervalo es
 * MÁXIMAMENTE INCLUSIVO y coincide con que los slots se ofrecen en su primera ocurrencia (review B-MED:
 * consistencia display/lock). `minuteOfDay===1440` (fin de día "24:00") → 00:00 del día siguiente.
 * Si el borde cae en un gap (sin candidatos), se desplaza con luxon directo (avanza al primer instante real).
 */
function wallBoundUtcMs(
  dateISO: string,
  minuteOfDay: number,
  tz: string,
  kind: 'lower' | 'upper'
): number {
  const [year, month, day] = dateISO.split('-').map(Number);
  if (minuteOfDay === 1440) {
    return DateTime.fromObject({ year, month, day }, { zone: tz })
      .plus({ days: 1 })
      .toUTC()
      .toMillis();
  }
  const cands = wallCandidatesMs(year, month, day, minuteOfDay, tz);
  if (cands.length === 0) {
    // borde en un gap: luxon lo lleva al primer instante real posterior (correcto para un borde).
    return DateTime.fromObject(
      { year, month, day, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 },
      { zone: tz }
    )
      .toUTC()
      .toMillis();
  }
  return kind === 'lower' ? Math.min(...cands) : Math.max(...cands);
}

/**
 * ¿El candidato solapa algún ocupado? Se expanden AMBOS por sus respectivos buffers (review B-HIGH):
 * el candidato por los buffers del tipo, y cada ocupado por SUS buffers. El hueco requerido entre dos
 * reuniones queda = bufferAfter del anterior + bufferBefore del siguiente (conservador y seguro: nunca
 * permite una reserva demasiado pegada). Half-open.
 */
function overlapsBusy(
  start: Date,
  end: Date,
  bufferBeforeMin: number,
  bufferAfterMin: number,
  busy: BusyInterval[]
): boolean {
  const candStart = start.getTime() - bufferBeforeMin * MIN;
  const candEnd = end.getTime() + bufferAfterMin * MIN;
  return busy.some((b) => {
    const bStart = b.start.getTime() - (b.bufferBeforeMin ?? 0) * MIN;
    const bEnd = b.end.getTime() + (b.bufferAfterMin ?? 0) * MIN;
    return candStart < bEnd && bStart < candEnd;
  });
}

export interface SlotCheckArgs {
  /** Inicio del slot (instante UTC). */
  start: Date;
  now: Date;
  schedule: ResolvedSchedule;
  params: SlotParams;
  busy: BusyInterval[];
  /** Reservas confirmadas YA existentes en el día-host del slot (sin contar la que se evalúa). */
  confirmedCountForDay: number;
}

/**
 * Predicado ÚNICO de validez de un slot — usado en display Y en el re-check bajo lock (review C-H1).
 * Verifica: anticipación mínima, ventana a futuro, pertenencia a un intervalo de disponibilidad
 * (alineado a la grilla), no-solapamiento con ocupados (buffers), y límite diario.
 */
export function isSlotBookable(args: SlotCheckArgs): boolean {
  const { start, now, schedule, params, busy, confirmedCountForDay } = args;
  if (!isValidZone(schedule.timezone)) return false;
  const startMs = start.getTime();
  const end = new Date(startMs + params.durationMinutes * MIN);

  // (a) anticipación mínima (en instantes UTC).
  if (startMs < now.getTime() + params.minimumNoticeMin * MIN) return false;
  // (b) ventana máxima a futuro.
  if (startMs > now.getTime() + params.dateRangeDays * 24 * 60 * MIN) return false;
  // (c) límite diario (sólo confirmadas, por día del anfitrión).
  if (params.dailyLimit && params.dailyLimit > 0 && confirmedCountForDay >= params.dailyLimit) {
    return false;
  }

  // (d) pertenece a un intervalo de disponibilidad de su fecha host, alineado a la grilla, y CABE
  // entero dentro de UN intervalo. Reconstruimos la hora-de-pared del candidato en la tz del host.
  const local = DateTime.fromMillis(startMs, { zone: schedule.timezone });
  const dateISO = local.toFormat('yyyy-MM-dd');
  const candidateStartMin = local.hour * 60 + local.minute;
  const increment = params.slotIncrementMin ?? params.durationMinutes;
  const intervals = availabilityIntervalsForDate(dateISO, schedule);
  const slotEndMs = startMs + params.durationMinutes * MIN;
  const fits = intervals.some((iv) => {
    if (candidateStartMin < iv.startMin) return false;
    // alineado a la grilla del intervalo (no permite tiempos arbitrarios off-grid).
    if ((candidateStartMin - iv.startMin) % increment !== 0) return false;
    // Contención en TIEMPO REAL (UTC): el slot [start, start+duración] debe caber entero dentro de los
    // límites UTC del intervalo. Esto rechaza una reunión que, por una transición DST en medio, termina
    // más tarde (en pared) de lo que la aritmética de minutos sugeriría (review B-HIGH).
    const ivStartMs = wallBoundUtcMs(dateISO, iv.startMin, schedule.timezone, 'lower');
    const ivEndMs = wallBoundUtcMs(dateISO, iv.endMin, schedule.timezone, 'upper');
    return startMs >= ivStartMs && slotEndMs <= ivEndMs;
  });
  if (!fits) return false;
  // re-resolver el candidato y exigir que coincida con `start` (descarta gaps/ambigüedades).
  const resolved = resolveSlotStart(dateISO, candidateStartMin, schedule.timezone);
  if (resolved?.getTime() !== startMs) return false;

  // (e) sin solapamiento con ocupados (buffers del propio tipo).
  if (overlapsBusy(start, end, params.bufferBeforeMin, params.bufferAfterMin, busy)) return false;
  return true;
}

export interface GenerateSlotsArgs {
  /** Ventana solicitada [from, to] (instantes UTC). */
  from: Date;
  to: Date;
  now: Date;
  schedule: ResolvedSchedule;
  params: SlotParams;
  busy: BusyInterval[];
  /**
   * Conteo de confirmadas por día-host ("YYYY-MM-DD" → n) para el límite diario. CONTRATO (review D):
   * el caller (3.4) debe poblarlo para TODOS los días de la ventana; un día ausente cuenta como 0 (sin
   * límite aplicado ese día). El motor no consulta la DB — es puro.
   */
  confirmedCountByDay?: Map<string, number>;
}

/**
 * Genera los slots disponibles en [from, to]. Itera por fecha host-local, tilea cada intervalo por
 * hora-de-pared, y filtra con `isSlotBookable`. Devuelve inicios en UTC, ordenados y SIN duplicados.
 *
 * CONTRATO del caller (review D, todos LOW): `from <= to` (si `from > to` devuelve `[]`); cada `busy[]`
 * con `start < end`; `confirmedCountByDay` poblado para todos los días de la ventana. La ventana debe
 * venir acotada (la ruta 3.4 la limita a ≤62 días; el cap interno de 400 es sólo un backstop anti-loop).
 */
export function generateSlots(args: GenerateSlotsArgs): Date[] {
  const { from, to, now, schedule, params, busy, confirmedCountByDay } = args;
  if (!isValidZone(schedule.timezone)) return [];
  const increment = params.slotIncrementMin ?? params.durationMinutes;
  if (increment <= 0) return [];

  const out: Date[] = [];
  // Iterar fechas host-local desde la del `from` hasta la del `to` (inclusive).
  let day = DateTime.fromMillis(from.getTime(), { zone: schedule.timezone }).startOf('day');
  const lastDay = DateTime.fromMillis(to.getTime(), { zone: schedule.timezone }).startOf('day');
  // Cap defensivo de iteraciones (la ventana ya viene acotada por la ruta, pero evitamos un loop largo).
  let guard = 0;
  while (day <= lastDay && guard < 400) {
    guard += 1;
    const dateISO = day.toFormat('yyyy-MM-dd');
    const dayCount = confirmedCountByDay?.get(dateISO) ?? 0;
    const intervals = availabilityIntervalsForDate(dateISO, schedule);
    for (const iv of intervals) {
      for (
        let startMin = iv.startMin;
        startMin + params.durationMinutes <= iv.endMin;
        startMin += increment
      ) {
        const start = resolveSlotStart(dateISO, startMin, schedule.timezone);
        if (!start) continue; // gap DST
        const startMs = start.getTime();
        if (startMs < from.getTime() || startMs > to.getTime()) continue; // fuera de la ventana
        if (
          isSlotBookable({
            start,
            now,
            schedule,
            params,
            busy,
            confirmedCountForDay: dayCount,
          })
        ) {
          out.push(start);
        }
      }
    }
    day = day.plus({ days: 1 });
  }
  // Dedup por instante: si el horario tiene intervalos SOLAPADOS (p.ej. 09–12 y 11–14), el tiling de
  // ambos generaría el mismo slot dos veces en el solape. Colapsamos a inicios únicos (auto-auditoría).
  const seen = new Set<number>();
  const unique: Date[] = [];
  for (const d of out) {
    const t = d.getTime();
    if (!seen.has(t)) {
      seen.add(t);
      unique.push(d);
    }
  }
  unique.sort((a, b) => a.getTime() - b.getTime());
  return unique;
}
