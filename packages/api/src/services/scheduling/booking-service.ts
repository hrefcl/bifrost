import mongoose from 'mongoose';
import { randomToken, hashToken } from '../../config/crypto.js';
import { withLock } from '../../lib/withLock.js';
import { Booking, type IBooking } from '../../models/Booking.js';
import { CalendarEvent } from '../../models/CalendarEvent.js';
import { type IEventType } from '../../models/EventType.js';
import { getMeetSettings } from '../meet/settings.js';
import { meetEnabled } from '../meet/token-service.js';
import {
  createBookingMeetRoom,
  deleteMeetRoomById,
  closeMeetRoomForBooking,
  migrateMeetRoomToBooking,
  getMeetRoomIdForBooking,
} from '../meet/booking-meet.js';
import { hostCalendarDay } from '../../lib/scheduling/time.js';
import {
  isSlotBookable,
  type BusyInterval,
  type ResolvedSchedule,
  type SlotParams,
} from '../../lib/scheduling/slots.js';
import { enqueue } from './queue.js';
import type { BookingInvitee, BookingAnswer, BookingSnapshot } from '@webmail6/shared';

/**
 * Servicio de reservas — el corazón de CONCURRENCIA de la agenda (review B/C/D del diseño).
 *
 * Garantías:
 *  - Lock distribuido por host (`withLock`, fail-closed): si no se adquiere → `unavailable` (409); si
 *    Redis cae, `withLock` LANZA → la ruta responde 503. NUNCA se degrada.
 *  - Re-validación del PREDICADO COMPLETO bajo lock (`isSlotBookable`) — mismo predicado del display.
 *  - Idempotencia DURABLE: lookup por `{userId,eventTypeId,idempotencyKeyHash}` antes de insertar; ante
 *    E11000 del índice, replay de la reserva existente.
 *  - Atomicidad sin transacciones: `Booking` es la fuente de verdad; el `CalendarEvent` es proyección.
 *    Si falla el insert del `CalendarEvent`, se COMPENSA borrando la `Booking` y se propaga (→503); un
 *    crash entre ambos lo repara el reconciler (Fase 3.4).
 *  - Email/ICS van FUERA del lock (se encolan en BullMQ tras el commit).
 */

const MIN = 60_000;
const LOCK_TTL_SECONDS = 120;
const LOCK_WAIT_MS = 2000;
/**
 * Padding de la ventana al consultar ocupados (review D-073 HIGH): un evento LEJANO con un buffer
 * grande puede bloquear el candidato. Con buffers ≤1440min (24h) y duración ≤1440min, un ocupado puede
 * impactar hasta ~72h antes/después. Padeamos 3 días para NO perder ningún ocupado relevante; el overlap
 * preciso (con buffers) lo decide `isSlotBookable`/`overlapsBusy`.
 */
export const BUSY_PAD_MS = 3 * 24 * 60 * MIN;

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

const lockKey = (userId: string): string => `lock:booking:host:${userId}`;

/**
 * Encola SIN hacer fallar la operación (review B-HIGH#4): el email es un efecto POST-commit; si la cola
 * falla, la reserva/cancelación YA quedó aplicada y el cliente debe recibir su respuesta. El reconciler
 * y la observabilidad cubren el email no enviado. (Mock/test: `enqueue` ya es no-op.)
 */
async function safeEnqueue(
  name: Parameters<typeof enqueue>[0],
  data: Record<string, unknown>,
  opts?: Parameters<typeof enqueue>[2]
): Promise<void> {
  try {
    await enqueue(name, data, opts);
  } catch (err) {
    console.error(
      `[scheduling] enqueue ${name} falló (la operación ya se aplicó): ${(err as Error).message}`
    );
  }
}

/**
 * Borra una MeetRoom de compensación SIN hacer fallar el flujo (review C-L1): si `deleteOne` lanza (Mongo
 * caído) dentro de un `catch` de compensación, NO debe enmascarar el `replay`/`conflict` correcto con un
 * 500. La sala huérfana es benigna (no enumerable, sin backlink válido, la purga el TTL `purgeAt`).
 */
async function safeDeleteMeetRoom(meetRoomId: mongoose.Types.ObjectId | undefined): Promise<void> {
  if (!meetRoomId) return;
  try {
    await deleteMeetRoomById(meetRoomId);
  } catch (err) {
    console.error(
      `[meet] no se pudo borrar la sala de compensación (benigna, TTL la purga): ${(err as Error).message}`
    );
  }
}

/** EventType → parámetros del motor de slots. */
export function slotParamsOf(ev: IEventType): SlotParams {
  return {
    durationMinutes: ev.durationMinutes,
    bufferBeforeMin: ev.bufferBeforeMin,
    bufferAfterMin: ev.bufferAfterMin,
    minimumNoticeMin: ev.minimumNoticeMin,
    dateRangeDays: ev.dateRangeDays,
    slotIncrementMin: ev.slotIncrementMin,
    dailyLimit: ev.dailyLimit,
  };
}

export function resolveSchedule(sched: {
  timezone: string;
  weeklyRules: ResolvedSchedule['weeklyRules'];
  overrides: ResolvedSchedule['overrides'];
}): ResolvedSchedule {
  return { timezone: sched.timezone, weeklyRules: sched.weeklyRules, overrides: sched.overrides };
}

/**
 * Intervalos OCUPADOS del host en [from,to]. Para NO doble-contar: las reservas confirmadas (con sus
 * buffers del snapshot) + los CalendarEvents MANUALES (source≠'booking'; los de booking ya están como
 * Booking). `excludeBookingId` permite excluir una reserva (self-exclusión al reagendar).
 */
function excludeClause(exclude?: string | string[]): Record<string, unknown> | undefined {
  if (!exclude) return undefined;
  return Array.isArray(exclude) ? { $nin: exclude } : { $ne: exclude };
}

export async function buildBusy(
  userId: string,
  from: Date,
  to: Date,
  excludeBookingId?: string | string[]
): Promise<BusyInterval[]> {
  const bookingFilter: Record<string, unknown> = {
    userId,
    status: 'confirmed',
    startAt: { $lt: to },
    endAt: { $gt: from },
  };
  const ex = excludeClause(excludeBookingId);
  if (ex) bookingFilter._id = ex;
  const [bookings, events] = await Promise.all([
    Booking.find(bookingFilter).select('startAt endAt snapshot'),
    CalendarEvent.find({
      userId,
      status: 'confirmed',
      source: { $ne: 'booking' },
      startDate: { $lt: to },
      endDate: { $gt: from },
    }).select('startDate endDate'),
  ]);
  return [
    ...bookings.map((b) => ({
      start: b.startAt,
      end: b.endAt,
      bufferBeforeMin: b.snapshot.bufferBeforeMin,
      bufferAfterMin: b.snapshot.bufferAfterMin,
    })),
    ...events.map((e) => ({ start: e.startDate, end: e.endDate })),
  ];
}

/** ¿El rango [start,end] (con buffers) solapa algún ocupado (con sus buffers)? Half-open. */
export function overlapsAny(
  start: Date,
  end: Date,
  bufBefore: number,
  bufAfter: number,
  busy: BusyInterval[]
): boolean {
  const bs = start.getTime() - bufBefore * MIN;
  const be = end.getTime() + bufAfter * MIN;
  return busy.some((o) => {
    const os = o.start.getTime() - (o.bufferBeforeMin ?? 0) * MIN;
    const oe = o.end.getTime() + (o.bufferAfterMin ?? 0) * MIN;
    return bs < oe && os < be;
  });
}

/** Conteo de reservas confirmadas por día-host en [from,to] (para dailyLimit). `excludeBookingId`
 *  permite no contar una reserva (la que se reagenda — review B-HIGH#6). */
export async function confirmedCountByDay(
  userId: string,
  from: Date,
  to: Date,
  hostTz: string,
  excludeBookingId?: string | string[]
): Promise<Map<string, number>> {
  const filter: Record<string, unknown> = {
    userId,
    status: 'confirmed',
    startAt: { $gte: from, $lt: to },
  };
  const ex = excludeClause(excludeBookingId);
  if (ex) filter._id = ex;
  const bookings = await Booking.find(filter).select('startAt');
  const map = new Map<string, number>();
  for (const b of bookings) {
    const day = hostCalendarDay(b.startAt, hostTz);
    map.set(day, (map.get(day) ?? 0) + 1);
  }
  return map;
}

export interface CreateBookingParams {
  eventType: IEventType;
  schedule: ResolvedSchedule;
  hostUserId: string;
  hostAccountId: string;
  startAt: Date;
  now: Date;
  invitee: BookingInvitee;
  answers: BookingAnswer[];
  idempotencyKey?: string;
}

export type CreateBookingResult =
  | { ok: true; booking: IBooking; rawToken: string | null; replay: boolean }
  | { ok: false; reason: 'conflict' | 'unavailable' };

/** Crea una reserva bajo lock con todas las garantías. `rawToken` sólo en creación nueva (no en replay). */
export async function createBooking(p: CreateBookingParams): Promise<CreateBookingResult> {
  const { eventType, schedule, hostUserId, hostAccountId, startAt, now, invitee, answers } = p;
  const params = slotParamsOf(eventType);
  const endAt = new Date(startAt.getTime() + params.durationMinutes * MIN);
  // Si el cliente no envía Idempotency-Key, se DERIVA por la identidad de la reserva (host+tipo+slot+
  // email): un retry del MISMO invitado al MISMO slot replayea en vez de chocar o duplicar (review B/D).
  const effectiveKey =
    p.idempotencyKey ??
    `auto:${eventType._id.toString()}:${startAt.toISOString()}:${invitee.email.toLowerCase()}`;
  const idemHash = hashToken(effectiveKey);
  const idemFilter = {
    userId: hostUserId,
    eventTypeId: eventType._id,
    idempotencyKeyHash: idemHash,
  };

  const snapshot: BookingSnapshot = {
    timezone: schedule.timezone,
    durationMinutes: params.durationMinutes,
    bufferBeforeMin: params.bufferBeforeMin,
    bufferAfterMin: params.bufferAfterMin,
    minimumNoticeMin: params.minimumNoticeMin,
    title: eventType.title,
    location: { type: eventType.location.type, value: eventType.location.value },
  };

  // Bifrost Meet: si el tipo lo habilita Y la feature está activa, la reserva genera una sala. El `_id`
  // se preasigna para que la `MeetRoom` referencie el `bookingId` ANTES de `Booking.create`, y la URL se
  // hornea en el snapshot inmutable (link estable; el worker de email/ICS lo lee tal cual; reschedule lo
  // hereda). La lectura de settings va fuera del lock (read-only). (review C-H1/C-H2, DESIGN §6)
  const meetSettings = await getMeetSettings();
  const wantMeet = eventType.meetEnabled === true && meetEnabled(meetSettings);
  const bookingId = new mongoose.Types.ObjectId();

  const outcome = await withLock(
    lockKey(hostUserId),
    async (): Promise<CreateBookingResult> => {
      // (a) idempotencia: replay si la misma key (o fingerprint) ya creó una reserva.
      {
        const existing = await Booking.findOne(idemFilter);
        if (existing) return { ok: true, booking: existing, rawToken: null, replay: true };
      }
      // (b) re-validar el PREDICADO COMPLETO contra el estado actual.
      const dayFrom = new Date(startAt.getTime() - BUSY_PAD_MS);
      const dayTo = new Date(endAt.getTime() + BUSY_PAD_MS);
      const [busy, counts] = await Promise.all([
        buildBusy(hostUserId, dayFrom, dayTo),
        confirmedCountByDay(hostUserId, dayFrom, dayTo, schedule.timezone),
      ]);
      const day = hostCalendarDay(startAt, schedule.timezone);
      const valid = isSlotBookable({
        start: startAt,
        now,
        schedule,
        params,
        busy,
        confirmedCountForDay: counts.get(day) ?? 0,
      });
      if (!valid) return { ok: false, reason: 'conflict' };

      // (c) tokens + ids.
      const rawToken = randomToken(32);
      const managementTokenHash = hashToken(rawToken);
      const icsUid = `${randomToken(16)}@bifrost-agenda`;

      // (c2) Bifrost Meet: crear la sala (write Mongo REQUERIDO, CERO RPC LiveKit → seguro bajo el lock) y
      // HORNEAR la URL en el snapshot inmutable. DEGRADADO (review C-H1): CUALQUIER error NO aborta la
      // reserva; el snapshot queda con la location original (NUNCA `video` sin URL). La sala LiveKit se
      // auto-crea al primer join; el cap lo fija `ensureRoom` (fuera del lock) + el techo global.
      let bookingSnapshot: BookingSnapshot = snapshot;
      let meetRoomId: mongoose.Types.ObjectId | undefined;
      let meetUrl: string | undefined;
      if (wantMeet) {
        try {
          const m = await createBookingMeetRoom({
            bookingId,
            userId: new mongoose.Types.ObjectId(hostUserId),
            name: eventType.title,
            endAt,
            settings: meetSettings,
          });
          meetRoomId = m.meetRoomId;
          meetUrl = m.meetUrl;
          bookingSnapshot = { ...snapshot, location: { type: 'video', value: meetUrl } };
        } catch (err) {
          console.error(
            `[meet] sala de la reserva no creada (degradado, la reserva sigue sin Meet): ${(err as Error).message}`
          );
        }
      }

      // (d) insertar Booking (fuente de verdad). `_id` preasignado para que la MeetRoom (creada arriba)
      // referencie este booking; `snapshot` horneado con la URL de Meet si aplica.
      let booking: IBooking;
      try {
        booking = await Booking.create({
          _id: bookingId,
          eventTypeId: eventType._id,
          userId: hostUserId,
          snapshot: bookingSnapshot,
          startAt,
          endAt,
          invitee,
          answers,
          status: 'confirmed',
          source: 'public',
          managementTokenHash,
          idempotencyKeyHash: idemHash,
          icsUid,
        });
      } catch (err) {
        // Compensación: la Booking no se insertó → borrar la MeetRoom huérfana (mismo bookingId).
        await safeDeleteMeetRoom(meetRoomId);
        if (isDuplicateKey(err)) {
          // ¿race de idempotencia (misma key/fingerprint)? → replay. Si no, backstop {userId,startAt} → conflicto.
          const existing = await Booking.findOne(idemFilter);
          if (existing) return { ok: true, booking: existing, rawToken: null, replay: true };
          return { ok: false, reason: 'conflict' };
        }
        throw err;
      }

      // (d2) BACKSTOP DURABLE DE RANGO (review B-HIGH#1): el índice único sólo cubre `startAt` EXACTO. Si
      // el lock fallara (Redis caído > TTL en plena sección crítica) dos reservas de rangos SOLAPADOS
      // podrían insertarse. Tras insertar, verificamos en DB que ninguna OTRA confirmada solape el rango
      // buffereado; si la hay, COMPENSAMOS (borramos ésta) → conflicto. Prefiere no-reserva a doble-reserva.
      {
        const others = await buildBusy(hostUserId, dayFrom, dayTo, booking._id.toString());
        if (overlapsAny(startAt, endAt, params.bufferBeforeMin, params.bufferAfterMin, others)) {
          await Booking.deleteOne({ _id: booking._id });
          await safeDeleteMeetRoom(meetRoomId); // compensar la sala
          return { ok: false, reason: 'conflict' };
        }
      }

      // (e) proyectar CalendarEvent. Compensación que borra TODO (booking+sala) si algo falla (B-HIGH#3).
      // La `location` y `meetUrl` salen del snapshot HORNEADO (misma URL que el email/ICS — review B-LOW).
      let ce;
      try {
        ce = await CalendarEvent.create({
          userId: hostUserId,
          accountId: hostAccountId,
          calendarId: 'bifrost-scheduling',
          calendarName: 'Reuniones',
          calendarColor: eventType.color,
          uid: icsUid,
          summary: `${eventType.title} · ${invitee.name}`,
          description: `Invitado: ${invitee.name} <${invitee.email}>`,
          location: bookingSnapshot.location.value,
          startDate: startAt,
          endDate: endAt,
          startTimezone: schedule.timezone,
          endTimezone: schedule.timezone,
          status: 'confirmed',
          source: 'booking',
          bookingId: booking._id,
          meetRoomId,
          meetUrl,
        });
      } catch (err) {
        await Booking.deleteOne({ _id: booking._id }); // el CE no se creó
        await safeDeleteMeetRoom(meetRoomId);
        throw err;
      }
      try {
        await Booking.updateOne({ _id: booking._id }, { $set: { calendarEventId: ce._id } });
        booking.calendarEventId = ce._id;
      } catch (err) {
        await CalendarEvent.deleteOne({ _id: ce._id }); // compensar el CE huérfano (review B-HIGH#3)
        await Booking.deleteOne({ _id: booking._id });
        await safeDeleteMeetRoom(meetRoomId);
        throw err;
      }

      return { ok: true, booking, rawToken, replay: false };
    },
    { ttlSeconds: LOCK_TTL_SECONDS, waitMs: LOCK_WAIT_MS }
  );

  // Lock no adquirido (otro booking del host en curso) → no disponible (la ruta → 409).
  if (outcome.skipped) return { ok: false, reason: 'unavailable' };
  const result = outcome.result;
  // Email/ICS FUERA del lock: encolar sólo en creación nueva (no en replay).
  if (result.ok && !result.replay) {
    await safeEnqueue(
      'send-email',
      { bookingId: result.booking._id.toString(), kind: 'confirmation' },
      { jobId: `confirm:${result.booking._id.toString()}` }
    );
  }
  return result;
}

/** Cancela una reserva (por token o por id). Idempotente. Cancela el CalendarEvent y encola email. */
export async function cancelBooking(
  booking: IBooking,
  by: 'invitee' | 'host',
  reason?: string
): Promise<IBooking> {
  if (booking.status === 'cancelled') {
    // Idempotente — PERO se reintenta el cierre de sala (review B-MED): si un cancel previo flipeó el
    // status pero el cierre de la sala falló, un retry lo repara (la sala sigue `active` en Mongo).
    await safeCloseMeetRoom(booking._id);
    return booking;
  }
  const updated = await Booking.findOneAndUpdate(
    { _id: booking._id, status: 'confirmed' },
    { $set: { status: 'cancelled', cancelledBy: by, cancelReason: reason } },
    { new: true }
  );
  if (!updated) {
    // Otro request la canceló entre medio → idempotente; intentar reparar el cierre de la sala igual.
    const now = await Booking.findById(booking._id);
    if (now?.status === 'cancelled') await safeCloseMeetRoom(now._id);
    return now ?? booking;
  }
  if (updated.calendarEventId) {
    await CalendarEvent.updateOne(
      { _id: updated.calendarEventId },
      { $set: { status: 'cancelled' } }
    );
  }
  await safeCloseMeetRoom(updated._id);
  await safeEnqueue(
    'send-email',
    { bookingId: updated._id.toString(), kind: 'cancellation' },
    { jobId: `cancel:${updated._id.toString()}` }
  );
  return updated;
}

/**
 * Cierra (soft) la sala Meet de una reserva + desconecta activos en LiveKit (best-effort). No-fatal e
 * IDEMPOTENTE (sólo actúa si la sala sigue `active`). El backlink ya bloquea tokens nuevos (booking
 * cancelado/rescheduled → 404); esto además evicta a los presentes. Reusable por todos los paths de cancel.
 */
export async function safeCloseMeetRoom(bookingId: mongoose.Types.ObjectId): Promise<void> {
  try {
    const meetSettings = await getMeetSettings();
    await closeMeetRoomForBooking({ bookingId, settings: meetSettings });
  } catch (err) {
    console.error(`[meet] cierre de sala al cancelar falló (no-fatal): ${(err as Error).message}`);
  }
}

export type RescheduleResult =
  | { ok: true; booking: IBooking; rawToken: string }
  | { ok: false; reason: 'conflict' | 'unavailable' | 'not_confirmed' };

/**
 * Reagenda CRASH-SAFE (review B-HIGH/C-H3): bajo el lock del host, CREA la nueva reserva (validando el
 * nuevo slot, EXCLUYENDO la vieja del overlap) y sólo si tiene éxito retira la vieja (rescheduled +
 * cancela su CalendarEvent + invalida su token). Si la nueva falla, la vieja queda intacta (confirmed).
 */
export async function rescheduleBooking(params: {
  old: IBooking;
  eventType: IEventType;
  schedule: ResolvedSchedule;
  hostAccountId: string;
  newStartAt: Date;
  now: Date;
}): Promise<RescheduleResult> {
  const { old, eventType, schedule, hostAccountId, newStartAt, now } = params;
  if (old.status !== 'confirmed') return { ok: false, reason: 'not_confirmed' };
  const hostUserId = old.userId.toString();

  const outcome = await withLock(
    lockKey(hostUserId),
    async (): Promise<RescheduleResult> => {
      // RE-LEER la vieja BAJO el lock (review B-HIGH#5): pudo cancelarse/reagendarse desde que se cargó.
      const current = await Booking.findById(old._id).select(
        'status snapshot invitee answers source calendarEventId'
      );
      if (current?.status !== 'confirmed') return { ok: false, reason: 'not_confirmed' };

      // VALIDAR Y PERSISTIR con el MISMO contrato (review B-MED): duración/buffers/minNotice del SNAPSHOT
      // (lo que el invitado agendó), política (dateRange/incremento/límite) del EventType actual.
      const slotParams: SlotParams = {
        durationMinutes: current.snapshot.durationMinutes,
        bufferBeforeMin: current.snapshot.bufferBeforeMin,
        bufferAfterMin: current.snapshot.bufferAfterMin,
        minimumNoticeMin: current.snapshot.minimumNoticeMin,
        dateRangeDays: eventType.dateRangeDays,
        slotIncrementMin: eventType.slotIncrementMin,
        dailyLimit: eventType.dailyLimit,
      };
      const newEnd = new Date(newStartAt.getTime() + slotParams.durationMinutes * MIN);
      const dayFrom = new Date(newStartAt.getTime() - BUSY_PAD_MS);
      const dayTo = new Date(newEnd.getTime() + BUSY_PAD_MS);
      const excludeBoth = [old._id.toString()];
      const [busy, counts] = await Promise.all([
        buildBusy(hostUserId, dayFrom, dayTo, excludeBoth), // self-exclusión (vieja, que se retira)
        confirmedCountByDay(hostUserId, dayFrom, dayTo, schedule.timezone, excludeBoth), // y del conteo (HIGH#6)
      ]);
      const day = hostCalendarDay(newStartAt, schedule.timezone);
      const valid = isSlotBookable({
        start: newStartAt,
        now,
        schedule,
        params: slotParams,
        busy,
        confirmedCountForDay: counts.get(day) ?? 0,
      });
      if (!valid) return { ok: false, reason: 'conflict' };

      const rawToken = randomToken(32);
      const icsUid = `${randomToken(16)}@bifrost-agenda`;
      let neo: IBooking;
      try {
        neo = await Booking.create({
          eventTypeId: eventType._id,
          userId: hostUserId,
          snapshot: current.snapshot,
          startAt: newStartAt,
          endAt: newEnd,
          invitee: current.invitee,
          answers: current.answers,
          status: 'confirmed',
          source: current.source,
          managementTokenHash: hashToken(rawToken),
          icsUid,
          rescheduledFromId: old._id,
          pendingReschedule: true,
        });
      } catch (err) {
        if (isDuplicateKey(err)) return { ok: false, reason: 'conflict' };
        throw err;
      }
      // BACKSTOP DURABLE DE RANGO para la nueva (paridad con createBooking — review B-HIGH): excluye la
      // nueva y la vieja (se va a retirar). Si otra confirmada solapa → compensa (borra neo) → conflicto.
      {
        const others = await buildBusy(hostUserId, dayFrom, dayTo, [
          neo._id.toString(),
          old._id.toString(),
        ]);
        if (
          overlapsAny(
            newStartAt,
            newEnd,
            slotParams.bufferBeforeMin,
            slotParams.bufferAfterMin,
            others
          )
        ) {
          await Booking.deleteOne({ _id: neo._id });
          return { ok: false, reason: 'conflict' };
        }
      }
      // Bifrost Meet: el nuevo booking hereda el snapshot (mismo `meetUrl` baked) → el link se PRESERVA.
      // La herencia se ata a la PRESENCIA REAL de una MeetRoom (no a `snapshot.location.type==='video'`,
      // que también capturaría URLs de video EXTERNAS — review D-003/C-L5): sólo si la vieja reserva tiene
      // sala Meet propagamos `meetRoomId`/`meetUrl` y migramos. Sin sala (URL externa o sala purgada) →
      // el reschedule NO trata el evento como Meet.
      const meetRoomId = await getMeetRoomIdForBooking(old._id);
      const inheritedMeetUrl =
        meetRoomId && current.snapshot.location.type === 'video'
          ? current.snapshot.location.value
          : undefined;

      // CalendarEvent con compensación SPLIT (paridad con createBooking — review B-MED): si falla el
      // updateOne, se borra el CE huérfano además de la Booking. `location` horneada del snapshot heredado.
      let ce;
      try {
        ce = await CalendarEvent.create({
          userId: hostUserId,
          accountId: hostAccountId,
          calendarId: 'bifrost-scheduling',
          calendarName: 'Reuniones',
          calendarColor: eventType.color,
          uid: icsUid,
          summary: `${eventType.title} · ${current.invitee.name}`,
          location: current.snapshot.location.value,
          startDate: newStartAt,
          endDate: newEnd,
          startTimezone: schedule.timezone,
          endTimezone: schedule.timezone,
          status: 'confirmed',
          source: 'booking',
          bookingId: neo._id,
          meetRoomId: inheritedMeetUrl ? meetRoomId : undefined,
          meetUrl: inheritedMeetUrl,
        });
      } catch (err) {
        await Booking.deleteOne({ _id: neo._id });
        throw err;
      }
      try {
        await Booking.updateOne({ _id: neo._id }, { $set: { calendarEventId: ce._id } });
        neo.calendarEventId = ce._id;
      } catch (err) {
        await CalendarEvent.deleteOne({ _id: ce._id });
        await Booking.deleteOne({ _id: neo._id });
        throw err;
      }

      // Bifrost Meet: migrar la sala old→neo ANTES de retirar la vieja, con ROLLBACK (review B-HIGH/D-002):
      // si la migración falla, NO completamos el reschedule (compensamos neo+CE) → el link NUNCA queda
      // muerto en un reschedule "exitoso". Tras migrar, la sala apunta a `neo` (confirmed) → token OK.
      if (inheritedMeetUrl) {
        let migrateFailed = false;
        try {
          const migrated = await migrateMeetRoomToBooking({
            fromBookingId: old._id,
            toBookingId: neo._id,
            newEndAt: newEnd,
          });
          // `null` = la sala que leímos se esfumó antes de migrar (purga TTL de una reunión ya vieja, o
          // anomalía). neo YA tiene el snapshot `video` heredado → si seguimos, sería un link muerto en un
          // reschedule "exitoso" (la MISMA clase del HIGH). Por eso se trata IGUAL que un throw: abortar.
          if (!migrated) migrateFailed = true;
        } catch (err) {
          migrateFailed = true;
          console.error(`[meet] migración de sala lanzó: ${(err as Error).message}`);
        }
        if (migrateFailed) {
          // Abortar el reschedule SIN dejar link muerto. CLAVE (review B-HIGH v2): un `findOneAndUpdate`
          // pudo COMMITEAR server-side y aun así reportar timeout al cliente → la sala podría ya estar en
          // `neo`. Si borramos `neo` sin más, el link (slug→bookingId=neo borrado) haría 404. Por eso,
          // ANTES de borrar `neo`, migramos la sala DE VUELTA a `old` (idempotente `{$in:[neo,old]}`):
          //   - si el migrate original NO aplicó → la sala sigue en `old`, el back es no-op.
          //   - si SÍ aplicó (commit + timeout) → el back la devuelve a `old` (confirmed, la válida).
          await migrateMeetRoomToBooking({
            fromBookingId: neo._id,
            toBookingId: old._id,
            newEndAt: old.endAt,
          }).catch((e: unknown) => {
            console.error(`[meet] migrate-back en rollback falló (reconciler F3.4): ${String(e)}`);
          });
          await CalendarEvent.deleteOne({ _id: ce._id });
          await Booking.deleteOne({ _id: neo._id });
          return { ok: false, reason: 'conflict' };
        }
      }

      // Retirar la vieja ATÓMICAMENTE (filtro status:'confirmed' — review B-HIGH#5): si otro la cambió,
      // se compensa borrando la nueva (no perdemos la vieja, que sigue confirmed) Y se migra la sala DE
      // VUELTA a la vieja (que sigue siendo la válida).
      const retired = await Booking.updateOne(
        { _id: old._id, status: 'confirmed' },
        { $set: { status: 'rescheduled', rescheduledToId: neo._id } }
      );
      if (retired.modifiedCount === 0) {
        if (inheritedMeetUrl) {
          // Revertir la migración: la sala vuelve a la vieja reserva (que sigue confirmed y es la válida).
          try {
            await migrateMeetRoomToBooking({
              fromBookingId: neo._id,
              toBookingId: old._id,
              newEndAt: old.endAt,
            });
          } catch (err) {
            console.error(
              `[meet] rollback de migración falló (reconciler F3.4): ${(err as Error).message}`
            );
          }
        }
        await CalendarEvent.deleteOne({ _id: neo.calendarEventId });
        await Booking.deleteOne({ _id: neo._id });
        return { ok: false, reason: 'not_confirmed' };
      }
      if (current.calendarEventId) {
        await CalendarEvent.updateOne(
          { _id: current.calendarEventId },
          { $set: { status: 'cancelled' } }
        );
      }
      await Booking.updateOne({ _id: neo._id }, { $unset: { pendingReschedule: 1 } });
      return { ok: true, booking: neo, rawToken };
    },
    { ttlSeconds: LOCK_TTL_SECONDS, waitMs: LOCK_WAIT_MS }
  );

  if (outcome.skipped) return { ok: false, reason: 'unavailable' };
  const result = outcome.result;
  if (result.ok) {
    // CANCEL del ICS viejo (review B-MED: si no, el cliente queda con el evento viejo + el nuevo).
    await safeEnqueue(
      'send-email',
      { bookingId: old._id.toString(), kind: 'cancellation' },
      { jobId: `reschedule-cancel:${old._id.toString()}` }
    );
    await safeEnqueue(
      'send-email',
      { bookingId: result.booking._id.toString(), kind: 'reschedule' },
      { jobId: `reschedule:${result.booking._id.toString()}` }
    );
  }
  return result;
}
