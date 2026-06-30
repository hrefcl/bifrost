import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { EventType, serializeEventType } from '../models/EventType.js';
import {
  AvailabilitySchedule,
  serializeAvailabilitySchedule,
} from '../models/AvailabilitySchedule.js';
import { Booking, serializeBooking } from '../models/Booking.js';
import { CalendarEvent } from '../models/CalendarEvent.js';
import { User } from '../models/User.js';
import { validateUsername, validateEventSlug } from '../lib/scheduling/slug.js';
import { isValidZone } from '../lib/scheduling/time.js';
import { getSchedulingSettings } from '../services/scheduling/settings.js';
import { safeCloseMeetRoom } from '../services/scheduling/booking-service.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const intervalSchema = z.object({ start: z.string().regex(HHMM), end: z.string().regex(HHMM) });
const locationSchema = z.object({
  type: z.enum(['in_person', 'phone', 'video', 'custom']),
  value: z.string().max(2048).optional(),
});
const questionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(256),
  type: z.enum(['text', 'textarea', 'phone']),
  required: z.boolean(),
});

const hhmmToMin = (s: string): number => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/** weeklyRules: sin weekday duplicado + intervalos válidos. */
function assertWeeklyRules(
  rules: { weekday: number; intervals: { start: string; end: string }[] }[]
): void {
  const seen = new Set<number>();
  for (const r of rules) {
    if (seen.has(r.weekday))
      throw badRequest(`weekday duplicado en weeklyRules: ${String(r.weekday)}`);
    seen.add(r.weekday);
    assertIntervals(r.intervals);
  }
}

/** overrides: sin fecha duplicada + fecha de CALENDARIO real (rechaza 2026-02-31) + intervalos válidos. */
function assertOverrides(
  overrides: { date: string; intervals: { start: string; end: string }[] }[]
): void {
  const seen = new Set<string>();
  for (const o of overrides) {
    if (seen.has(o.date)) throw badRequest(`fecha duplicada en overrides: ${o.date}`);
    seen.add(o.date);
    if (!DateTime.fromISO(o.date).isValid)
      throw badRequest(`fecha de override inválida: ${o.date}`);
    assertIntervals(o.intervals);
  }
}

/** Valida intervalos: HH:MM (sólo el END puede ser 24:00), end>start, sin solapes. Lanza 400 si no. */
function assertIntervals(intervals: { start: string; end: string }[]): void {
  for (const iv of intervals) {
    if (iv.start === '24:00') {
      throw badRequest('Sólo el fin de un intervalo puede ser 24:00');
    }
    if (hhmmToMin(iv.end) <= hhmmToMin(iv.start)) {
      throw badRequest(
        `Intervalo inválido: ${iv.start}–${iv.end} (fin debe ser posterior al inicio)`
      );
    }
  }
  const sorted = [...intervals].sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start));
  for (let i = 1; i < sorted.length; i++) {
    if (hhmmToMin(sorted[i].start) < hhmmToMin(sorted[i - 1].end)) {
      throw badRequest('Los intervalos de un día no pueden solaparse');
    }
  }
}

function badRequest(message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = 400;
  e.name = 'Bad Request';
  return e;
}
function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export default function scheduleRoutes(fastify: FastifyInstance) {
  // ───────────────────────── EVENT TYPES ─────────────────────────
  const eventTypeBody = z.object({
    slug: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    description: z.string().max(4096).optional(),
    durationMinutes: z.number().int().min(5).max(1440),
    color: z.string().max(32).optional(),
    location: locationSchema,
    bufferBeforeMin: z.number().int().min(0).max(1440).default(0),
    bufferAfterMin: z.number().int().min(0).max(1440).default(0),
    minimumNoticeMin: z.number().int().min(0).max(525600).default(0), // ≤ 1 año (review C-4)
    dateRangeDays: z.number().int().min(1).max(365).default(60),
    slotIncrementMin: z.number().int().min(1).max(1440).optional(),
    dailyLimit: z.number().int().min(0).max(1000).optional(),
    availabilityScheduleId: objectId,
    cancellationPolicyText: z.string().max(2048).optional(),
    reschedulePolicyText: z.string().max(2048).optional(),
    cancelMinNoticeMin: z.number().int().min(0).max(525600).optional(),
    customQuestions: z
      .array(questionSchema)
      .max(20)
      .default([])
      // ids únicos (review D-072): preguntas con id repetido romperían el mapeo de respuestas.
      .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, {
        message: 'customQuestions: cada pregunta debe tener un id único',
      }),
    active: z.boolean().default(true),
    // Bifrost Meet: si las reservas de este tipo generan una sala de videollamada (F3.2).
    meetEnabled: z.boolean().optional(),
  });

  async function assertOwnedSchedule(userId: string, scheduleId: string): Promise<void> {
    const sched = await AvailabilitySchedule.findOne({ _id: scheduleId, userId }).select('_id');
    if (!sched) throw badRequest('availabilityScheduleId no existe o no es tuyo');
  }

  fastify.get('/event-types', async (request) => {
    const list = await EventType.find({ userId: request.user.userId }).sort({ createdAt: 1 });
    return list.map(serializeEventType);
  });

  fastify.post('/event-types', async (request, reply) => {
    const body = eventTypeBody.parse(request.body);
    const slug = validateEventSlug(body.slug);
    if (!slug.ok)
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: slug.reason });
    await assertOwnedSchedule(request.user.userId, body.availabilityScheduleId);
    // Límite por usuario (review B-MED): si el admin lo configuró, contar tipos activos antes de crear.
    // `typeof === 'number'` (no `!== undefined`): un `null` persistido coercionaba `count >= null` a
    // `count >= 0` → siempre bloqueaba (hallazgo E2E).
    const settings = await getSchedulingSettings();
    if (typeof settings.maxEventTypesPerUser === 'number') {
      const count = await EventType.countDocuments({
        userId: request.user.userId,
        active: true,
      });
      if (count >= settings.maxEventTypesPerUser) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Alcanzaste el máximo de ${String(settings.maxEventTypesPerUser)} tipos de reunión`,
        });
      }
    }
    try {
      const ev = await EventType.create({ ...body, slug: slug.value, userId: request.user.userId });
      return serializeEventType(ev);
    } catch (err) {
      if (isDuplicateKey(err)) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Ya tienes un tipo con ese enlace',
        });
      }
      throw err;
    }
  });

  fastify.get('/event-types/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    objectId.parse(id);
    const ev = await EventType.findOne({ _id: id, userId: request.user.userId });
    if (!ev)
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Event type not found' });
    return serializeEventType(ev);
  });

  fastify.patch('/event-types/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    objectId.parse(id);
    const body = eventTypeBody.partial().parse(request.body);
    const update: Record<string, unknown> = { ...body };
    if (body.slug !== undefined) {
      const slug = validateEventSlug(body.slug);
      if (!slug.ok)
        return reply
          .code(400)
          .send({ statusCode: 400, error: 'Bad Request', message: slug.reason });
      update.slug = slug.value;
    }
    if (body.availabilityScheduleId)
      await assertOwnedSchedule(request.user.userId, body.availabilityScheduleId);
    // Reactivar (active:false→true) un tipo soft-borrado también consume cupo: evita evadir
    // maxEventTypesPerUser reactivando en lugar de crear (re-auditoría hostil — bypass del límite).
    if (body.active === true) {
      const settings = await getSchedulingSettings();
      if (typeof settings.maxEventTypesPerUser === 'number') {
        const current = await EventType.findOne({ _id: id, userId: request.user.userId }).select(
          'active'
        );
        if (current && !current.active) {
          const count = await EventType.countDocuments({
            userId: request.user.userId,
            active: true,
          });
          if (count >= settings.maxEventTypesPerUser) {
            return reply.code(409).send({
              statusCode: 409,
              error: 'Conflict',
              message: `Alcanzaste el máximo de ${String(settings.maxEventTypesPerUser)} tipos de reunión`,
            });
          }
        }
      }
    }
    let ev;
    try {
      ev = await EventType.findOneAndUpdate(
        { _id: id, userId: request.user.userId },
        { $set: update },
        { new: true }
      );
    } catch (err) {
      if (isDuplicateKey(err)) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Ya tienes un tipo con ese enlace',
        });
      }
      throw err;
    }
    if (!ev)
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Event type not found' });
    return serializeEventType(ev);
  });

  // DELETE = SOFT (desactivar). Nunca hard-delete: las bookings conservan su snapshot (review C-M7).
  fastify.delete('/event-types/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    objectId.parse(id);
    const ev = await EventType.findOneAndUpdate(
      { _id: id, userId: request.user.userId },
      { $set: { active: false } },
      { new: true }
    );
    if (!ev)
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Event type not found' });
    return { ok: true, deactivated: true };
  });

  // ───────────────────────── AVAILABILITY ─────────────────────────
  const availabilityBody = z.object({
    name: z.string().min(1).max(120),
    timezone: z.string().min(1),
    weeklyRules: z
      .array(
        z.object({
          weekday: z.number().int().min(0).max(6),
          intervals: z.array(intervalSchema).max(12),
        })
      )
      .default([]),
    overrides: z
      .array(
        z.object({
          date: z.string().regex(YMD),
          intervals: z.array(intervalSchema).max(12),
          note: z.string().max(256).optional(),
        })
      )
      .max(366)
      .default([]),
    isDefault: z.boolean().default(false),
  });

  function assertAvailabilityValid(body: z.infer<typeof availabilityBody>): void {
    if (!isValidZone(body.timezone)) throw badRequest('Zona horaria inválida (debe ser IANA)');
    assertWeeklyRules(body.weeklyRules);
    assertOverrides(body.overrides);
  }

  /**
   * Fija el default del usuario como un UPDATE ATÓMICO de UN solo documento (User.defaultScheduleId)
   * — review B: elimina el patrón boolean+índice (clear-then-set no-transaccional, con ventana de
   * "cero defaults"). Aquí no hay ventana: el puntero pasa de A a B en una sola operación atómica.
   */
  async function setDefaultSchedule(userId: string, scheduleId: string | null): Promise<void> {
    if (scheduleId === null) {
      await User.updateOne({ _id: userId }, { $unset: { defaultScheduleId: 1 } });
    } else {
      await User.updateOne({ _id: userId }, { $set: { defaultScheduleId: scheduleId } });
    }
  }
  async function getDefaultId(userId: string): Promise<string | null> {
    const u = await User.findById(userId).select('defaultScheduleId').lean();
    return u?.defaultScheduleId ? u.defaultScheduleId.toString() : null;
  }

  fastify.get('/availability', async (request) => {
    const [list, defaultId] = await Promise.all([
      AvailabilitySchedule.find({ userId: request.user.userId }).sort({ createdAt: 1 }),
      getDefaultId(request.user.userId),
    ]);
    return list.map((s) => serializeAvailabilitySchedule(s, s._id.toString() === defaultId));
  });

  fastify.post('/availability', async (request) => {
    const body = availabilityBody.parse(request.body);
    assertAvailabilityValid(body);
    const count = await AvailabilitySchedule.countDocuments({ userId: request.user.userId });
    const sched = await AvailabilitySchedule.create({ ...body, userId: request.user.userId });
    // El primer horario, o uno marcado isDefault, pasa a ser el default (set atómico del puntero).
    const makeDefault = body.isDefault || count === 0;
    if (makeDefault) await setDefaultSchedule(request.user.userId, sched._id.toString());
    return serializeAvailabilitySchedule(sched, makeDefault);
  });

  fastify.patch('/availability/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    objectId.parse(id);
    const body = availabilityBody.partial().parse(request.body);
    if (body.timezone !== undefined && !isValidZone(body.timezone)) {
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'Zona horaria inválida' });
    }
    if (body.weeklyRules) assertWeeklyRules(body.weeklyRules);
    if (body.overrides) assertOverrides(body.overrides);
    // isDefault:true → set atómico del puntero. isDefault:false se IGNORA (el default sólo cambia
    // fijando OTRO como default → nunca quedan cero defaults; review B).
    const { isDefault, ...rest } = body;
    const sched = await AvailabilitySchedule.findOneAndUpdate(
      { _id: id, userId: request.user.userId },
      { $set: rest },
      { new: true }
    );
    if (!sched)
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Schedule not found' });
    if (isDefault === true) await setDefaultSchedule(request.user.userId, id);
    const defaultId = await getDefaultId(request.user.userId);
    return serializeAvailabilitySchedule(sched, sched._id.toString() === defaultId);
  });

  fastify.delete('/availability/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    objectId.parse(id);
    // No borrar si algún EventType lo usa (rompería el cálculo de slots de ese tipo).
    const inUse = await EventType.exists({
      userId: request.user.userId,
      availabilityScheduleId: id,
    });
    if (inUse) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Un tipo de reunión usa este horario',
      });
    }
    const sched = await AvailabilitySchedule.findOne({ _id: id, userId: request.user.userId });
    if (!sched)
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Schedule not found' });
    // Invariante "exactamente un default si queda ≥1" (review B), robusto ante crash entre pasos:
    //  - si quedan OTROS horarios: mover el puntero al más antiguo restante ANTES de borrar (el puntero
    //    nunca apunta a un doc borrado mientras quedan horarios);
    //  - si es el ÚLTIMO: borrar PRIMERO y luego $unset (no hay ventana con "1 horario y 0 defaults":
    //    tras el delete no queda ninguno → el invariante se cumple de forma vacía).
    const deletingDefault = (await getDefaultId(request.user.userId)) === id;
    const next = deletingDefault
      ? await AvailabilitySchedule.findOne({ userId: request.user.userId, _id: { $ne: id } }).sort({
          createdAt: 1,
        })
      : null;
    if (deletingDefault && next) await setDefaultSchedule(request.user.userId, next._id.toString());
    await AvailabilitySchedule.deleteOne({ _id: id, userId: request.user.userId });
    if (deletingDefault && !next) await setDefaultSchedule(request.user.userId, null);
    return { ok: true };
  });

  // ───────────────────────── PROFILE (username público) ─────────────────────────
  fastify.get('/profile', async (request) => {
    const user = await User.findById(request.user.userId)
      .select('username displayName avatarUrl')
      .lean();
    return {
      username: user?.username ?? null,
      displayName: user?.displayName ?? '',
      avatarUrl: user?.avatarUrl,
    };
  });

  fastify.patch('/profile', async (request, reply) => {
    const body = z.object({ username: z.string().max(64).nullable() }).parse(request.body);
    if (body.username === null || body.username.trim() === '') {
      // Vaciar el username: $unset para que NO entre como '' al índice parcial (review B-MED).
      await User.updateOne({ _id: request.user.userId }, { $unset: { username: 1 } });
      return { username: null };
    }
    const check = validateUsername(body.username);
    if (!check.ok)
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: check.reason });
    try {
      await User.updateOne({ _id: request.user.userId }, { $set: { username: check.value } });
      return { username: check.value };
    } catch (err) {
      if (isDuplicateKey(err)) {
        return reply
          .code(409)
          .send({ statusCode: 409, error: 'Conflict', message: 'Ese enlace ya está en uso' });
      }
      throw err;
    }
  });

  // ───────────────────────── BOOKINGS (host) ─────────────────────────
  const bookingsQuery = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    status: z.enum(['confirmed', 'cancelled', 'rescheduled']).optional(),
  });

  fastify.get('/bookings', async (request) => {
    const q = bookingsQuery.parse(request.query);
    const filter: Record<string, unknown> = { userId: request.user.userId };
    if (q.status) filter.status = q.status;
    const range: Record<string, Date> = {};
    if (q.from) range.$gte = new Date(q.from);
    if (q.to) range.$lte = new Date(q.to);
    if (Object.keys(range).length > 0) filter.startAt = range;
    const list = await Booking.find(filter).sort({ startAt: 1 }).limit(500);
    return list.map(serializeBooking);
  });

  fastify.post('/bookings/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    objectId.parse(id);
    const body = z.object({ reason: z.string().max(1024).optional() }).parse(request.body ?? {});
    const existing = await Booking.findOne({ _id: id, userId: request.user.userId });
    if (!existing)
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Reserva no encontrada' });
    // HTTP-idempotente (review B-LOW): un retry de una cancelación ya aplicada devuelve la reserva (200).
    // Reintentar el cierre de la sala Meet por si un cancel previo no lo completó (review B-MED).
    if (existing.status === 'cancelled') {
      await safeCloseMeetRoom(existing._id);
      return serializeBooking(existing);
    }
    // Una reserva reprogramada es terminal: no se cancela (se cancela/gestiona la nueva).
    if (existing.status !== 'confirmed') {
      return reply
        .code(409)
        .send({ statusCode: 409, error: 'Conflict', message: 'La reserva no está confirmada' });
    }
    // Transición atómica confirmed→cancelled (evita doble-efecto bajo retries concurrentes).
    const booking = await Booking.findOneAndUpdate(
      { _id: id, userId: request.user.userId, status: 'confirmed' },
      { $set: { status: 'cancelled', cancelledBy: 'host', cancelReason: body.reason } },
      { new: true }
    );
    if (!booking) {
      // Otro request la canceló entre el findOne y aquí → idempotente: devolver el estado actual.
      const now = await Booking.findOne({ _id: id, userId: request.user.userId });
      if (now) return serializeBooking(now);
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Reserva no encontrada' });
    }
    // Cancelar (no borrar) el CalendarEvent proyectado → libera el slot y conserva auditoría (review D-003).
    if (booking.calendarEventId) {
      await CalendarEvent.updateOne(
        { _id: booking.calendarEventId, userId: request.user.userId },
        { $set: { status: 'cancelled' } }
      );
    }
    // Bifrost Meet: cerrar la sala de la reserva + evictar activos (review D-001 HIGH). El cancel por host
    // antes NO pasaba por `cancelBooking`, dejando la sala `active`. Idempotente y no-fatal.
    await safeCloseMeetRoom(booking._id);
    // TODO(Fase 3.4): encolar email de cancelación al invitado (BullMQ).
    return serializeBooking(booking);
  });
}
