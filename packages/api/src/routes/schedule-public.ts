import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashToken } from '../config/crypto.js';
import { User } from '../models/User.js';
import { EventType } from '../models/EventType.js';
import { AvailabilitySchedule } from '../models/AvailabilitySchedule.js';
import { Account } from '../models/Account.js';
import { Booking, serializeBooking } from '../models/Booking.js';
import { isValidZone } from '../lib/scheduling/time.js';
import { generateSlots } from '../lib/scheduling/slots.js';
import { getSchedulingSettings } from '../services/scheduling/settings.js';
import {
  createBooking,
  cancelBooking,
  rescheduleBooking,
  buildBusy,
  confirmedCountByDay,
  resolveSchedule,
  slotParamsOf,
  BUSY_PAD_MS,
} from '../services/scheduling/booking-service.js';
import type { PublicEventType, PublicSchedulingProfile } from '@webmail6/shared';

const MAX_SLOT_WINDOW_DAYS = 62;
const DAY = 24 * 60 * 60_000;

/** Rutas PÚBLICAS (sin auth). Gateadas por SchedulingSettings.enabled (salvo gestión por token). */
export default function schedulePublicRoutes(fastify: FastifyInstance) {
  // Todas las rutas de este plugin son públicas.
  const PUBLIC = { config: { requiresAuth: false } } as const;
  // Rate-limit reforzado en el hot path (review B/D): además del limiter global.
  const BOOK_LIMIT = {
    config: { requiresAuth: false, rateLimit: { max: 20, timeWindow: '1 minute' } },
  } as const;

  function publicEventType(ev: {
    slug: string;
    title: string;
    description?: string;
    durationMinutes: number;
    color?: string;
    location: { type: PublicEventType['location']['type']; value?: string };
    customQuestions: PublicEventType['customQuestions'];
  }): PublicEventType {
    return {
      slug: ev.slug,
      title: ev.title,
      description: ev.description,
      durationMinutes: ev.durationMinutes,
      color: ev.color,
      // Privacidad (review B-HIGH): NO exponer `location.value` (URL de videollamada, dirección,
      // teléfono privado) en endpoints públicos pre-reserva. El invitado lo recibe DESPUÉS de reservar,
      // vía el correo de confirmación y el snapshot del booking (gateado por token de gestión).
      location: { type: ev.location.type },
      customQuestions: ev.customQuestions,
    };
  }

  // Gate de DESCUBRIMIENTO + nueva reserva: requiere la feature activa Y los links públicos habilitados
  // (review B-MED: `publicLinksEnabled` era no-op). La gestión por token NO usa este gate (sigue operativa).
  async function enabled(): Promise<boolean> {
    const s = await getSchedulingSettings();
    return s.enabled && s.publicLinksEnabled;
  }
  const gone = (reply: import('fastify').FastifyReply, code = 404) =>
    reply.code(code).send({ statusCode: code, error: 'Not Found', message: 'No disponible' });

  // ───────── Perfil público ─────────
  fastify.get('/:userSlug', PUBLIC, async (request, reply) => {
    if (!(await enabled())) return gone(reply);
    const { userSlug } = request.params as { userSlug: string };
    const user = await User.findOne({ username: userSlug.toLowerCase() }).lean();
    if (!user) return gone(reply);
    // La página sólo existe si el host puede confirmar (cuenta primaria con SMTP) — decisión de producto.
    const hasSmtp = await Account.exists({ userId: user._id, isPrimary: true });
    if (!hasSmtp) return gone(reply);
    const events = await EventType.find({ userId: user._id, active: true }).sort({ createdAt: 1 });
    const profile: PublicSchedulingProfile = {
      username: user.username ?? userSlug,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      eventTypes: events.map(publicEventType),
    };
    return profile;
  });

  // ───────── Detalle de un tipo ─────────
  fastify.get('/:userSlug/:eventSlug', PUBLIC, async (request, reply) => {
    if (!(await enabled())) return gone(reply);
    const { userSlug, eventSlug } = request.params as { userSlug: string; eventSlug: string };
    const user = await User.findOne({ username: userSlug.toLowerCase() }).lean();
    if (!user) return gone(reply);
    const ev = await EventType.findOne({
      userId: user._id,
      slug: eventSlug.toLowerCase(),
      active: true,
    });
    if (!ev) return gone(reply);
    return publicEventType(ev);
  });

  // ───────── Slots disponibles ─────────
  const slotsQuery = z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    tz: z.string().optional(),
  });
  fastify.get('/:userSlug/:eventSlug/slots', PUBLIC, async (request, reply) => {
    if (!(await enabled())) return gone(reply);
    const { userSlug, eventSlug } = request.params as { userSlug: string; eventSlug: string };
    const parsed = slotsQuery.safeParse(request.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'from/to inválidos' });
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (to <= from)
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'to debe ser > from' });
    if (to.getTime() - from.getTime() > MAX_SLOT_WINDOW_DAYS * DAY) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `ventana máx ${String(MAX_SLOT_WINDOW_DAYS)} días`,
      });
    }
    if (parsed.data.tz !== undefined && !isValidZone(parsed.data.tz)) {
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'tz inválida' });
    }
    const user = await User.findOne({ username: userSlug.toLowerCase() }).lean();
    if (!user) return gone(reply);
    const ev = await EventType.findOne({
      userId: user._id,
      slug: eventSlug.toLowerCase(),
      active: true,
    });
    if (!ev) return gone(reply);
    const sched = await AvailabilitySchedule.findById(ev.availabilityScheduleId);
    if (!sched) return gone(reply);
    const schedule = resolveSchedule(sched);
    // Padding de la consulta de ocupados (review B-MED/D-073): un ocupado fuera de [from,to] con buffer
    // grande puede bloquear slots DENTRO de la ventana. El motor filtra el rango real con precisión.
    const padFrom = new Date(from.getTime() - BUSY_PAD_MS);
    const padTo = new Date(to.getTime() + BUSY_PAD_MS);
    const [busy, counts] = await Promise.all([
      buildBusy(user._id.toString(), padFrom, padTo),
      confirmedCountByDay(user._id.toString(), padFrom, padTo, schedule.timezone),
    ]);
    const slots = generateSlots({
      from,
      to,
      now: new Date(),
      schedule,
      params: slotParamsOf(ev),
      busy,
      confirmedCountByDay: counts,
    });
    return { slots: slots.map((d) => ({ start: d.toISOString() })) };
  });

  // ───────── Reservar (hot path) ─────────
  const bookBody = z.object({
    startAt: z.string().datetime(),
    invitee: z.object({
      name: z.string().min(1).max(200),
      email: z.string().email().max(320),
      timezone: z.string().refine(isValidZone, 'tz inválida'),
      phone: z.string().max(64).optional(),
    }),
    answers: z
      .array(
        z.object({
          questionId: z.string().max(64),
          label: z.string().max(256),
          answer: z.string().max(4096),
        })
      )
      .max(20)
      .default([]),
  });
  fastify.post('/:userSlug/:eventSlug/book', BOOK_LIMIT, async (request, reply) => {
    if (!(await enabled())) return gone(reply);
    const { userSlug, eventSlug } = request.params as { userSlug: string; eventSlug: string };
    const body = bookBody.parse(request.body);
    const user = await User.findOne({ username: userSlug.toLowerCase() }).lean();
    if (!user) return gone(reply);
    const ev = await EventType.findOne({
      userId: user._id,
      slug: eventSlug.toLowerCase(),
      active: true,
    });
    if (!ev) return gone(reply);
    const sched = await AvailabilitySchedule.findById(ev.availabilityScheduleId);
    if (!sched) return gone(reply);
    const account = await Account.findOne({ userId: user._id, isPrimary: true }).select('_id');
    if (!account) return gone(reply); // sin SMTP no se agenda

    // Validar answers contra las preguntas del tipo (review C-12): ids válidos + requeridas respondidas.
    const validQ = new Map(ev.customQuestions.map((q) => [q.id, q]));
    for (const a of body.answers) {
      if (!validQ.has(a.questionId)) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: 'Bad Request', message: 'Pregunta desconocida' });
      }
    }
    const answered = new Set(
      body.answers.filter((a) => a.answer.trim().length > 0).map((a) => a.questionId)
    );
    for (const q of ev.customQuestions) {
      if (q.required && !answered.has(q.id)) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: 'Bad Request', message: `Falta responder: ${q.label}` });
      }
    }

    const idempotencyKey = request.headers['idempotency-key'];
    let result;
    try {
      result = await createBooking({
        eventType: ev,
        schedule: resolveSchedule(sched),
        hostUserId: user._id.toString(),
        hostAccountId: account._id.toString(),
        startAt: new Date(body.startAt),
        now: new Date(),
        invitee: body.invitee,
        answers: body.answers,
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
      });
    } catch {
      // withLock LANZA si Redis está caído → FAIL-CLOSED 503 (review B-HIGH#2). Nunca se degrada.
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Intenta de nuevo en un momento',
      });
    }
    if (!result.ok) {
      // `conflict` (slot tomado) y `unavailable` (lock ocupado por otro booking del host) → 409: reintentar.
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Ese horario ya no está disponible, elige otro',
      });
    }
    // El managementToken (raw) sólo se devuelve en creación nueva; en replay no se reexpone.
    return reply.code(201).send({
      booking: serializeBooking(result.booking),
      managementToken: result.rawToken,
    });
  });

  // ───────── Gestión por token (sigue operativa aunque enabled=false — review C-M9) ─────────
  const tokenParam = z.string().min(20).max(200);

  async function bookingByToken(token: string) {
    const parsed = tokenParam.safeParse(token);
    if (!parsed.success) return null;
    return Booking.findOne({ managementTokenHash: hashToken(parsed.data) });
  }

  fastify.get('/booking/:token', PUBLIC, async (request, reply) => {
    const { token } = request.params as { token: string };
    const booking = await bookingByToken(token);
    if (!booking) return gone(reply);
    return serializeBooking(booking);
  });

  // Slots para REAGENDAR (autenticado por el token de gestión, no por enabled — review C-M9).
  // Excluye el propio booking del cálculo de ocupados para que su hueco actual sea elegible.
  fastify.get('/booking/:token/slots', PUBLIC, async (request, reply) => {
    const { token } = request.params as { token: string };
    const parsed = slotsQuery.safeParse(request.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'from/to inválidos' });
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (to <= from || to.getTime() - from.getTime() > MAX_SLOT_WINDOW_DAYS * DAY)
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'ventana inválida' });
    if (parsed.data.tz !== undefined && !isValidZone(parsed.data.tz))
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'tz inválida' });
    const booking = await bookingByToken(token);
    if (booking?.status !== 'confirmed') return gone(reply);
    const ev = await EventType.findById(booking.eventTypeId);
    if (!ev) return gone(reply);
    const sched = await AvailabilitySchedule.findById(ev.availabilityScheduleId);
    if (!sched) return gone(reply);
    const schedule = resolveSchedule(sched);
    const padFrom = new Date(from.getTime() - BUSY_PAD_MS);
    const padTo = new Date(to.getTime() + BUSY_PAD_MS);
    const [busy, counts] = await Promise.all([
      buildBusy(booking.userId.toString(), padFrom, padTo, booking._id.toString()),
      confirmedCountByDay(booking.userId.toString(), padFrom, padTo, schedule.timezone, [
        booking._id.toString(),
      ]),
    ]);
    const slots = generateSlots({
      from,
      to,
      now: new Date(),
      schedule,
      params: slotParamsOf(ev),
      busy,
      confirmedCountByDay: counts,
    });
    return { slots: slots.map((d) => ({ start: d.toISOString() })) };
  });

  fastify.post('/booking/:token/cancel', PUBLIC, async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = z.object({ reason: z.string().max(1024).optional() }).parse(request.body ?? {});
    const booking = await bookingByToken(token);
    if (!booking) return gone(reply);
    if (booking.status === 'rescheduled') return gone(reply, 410); // token viejo de una reagendada
    const updated = await cancelBooking(booking, 'invitee', body.reason);
    return serializeBooking(updated);
  });

  fastify.post('/booking/:token/reschedule', PUBLIC, async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = z.object({ startAt: z.string().datetime() }).parse(request.body);
    const booking = await bookingByToken(token);
    if (!booking) return gone(reply);
    if (booking.status !== 'confirmed') return gone(reply, 410);
    const ev = await EventType.findById(booking.eventTypeId);
    if (!ev) return gone(reply);
    const sched = await AvailabilitySchedule.findById(ev.availabilityScheduleId);
    if (!sched) return gone(reply);
    const account = await Account.findOne({ userId: booking.userId, isPrimary: true }).select(
      '_id'
    );
    if (!account) return gone(reply);
    let result;
    try {
      result = await rescheduleBooking({
        old: booking,
        eventType: ev,
        schedule: resolveSchedule(sched),
        hostAccountId: account._id.toString(),
        newStartAt: new Date(body.startAt),
        now: new Date(),
      });
    } catch {
      return reply
        .code(503)
        .send({ statusCode: 503, error: 'Service Unavailable', message: 'Intenta de nuevo' });
    }
    if (!result.ok) {
      if (result.reason === 'not_confirmed') return gone(reply, 410);
      // conflict o unavailable → 409.
      return reply
        .code(409)
        .send({ statusCode: 409, error: 'Conflict', message: 'Ese horario ya no está disponible' });
    }
    return reply
      .code(200)
      .send({ booking: serializeBooking(result.booking), managementToken: result.rawToken });
  });
}
