import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';
import { CalendarEvent, serializeCalendarEvent } from '../models/CalendarEvent.js';
import { requireOwnedAccount } from '../lib/authz.js';
import { googleEnabled } from '../services/google/creds.js';
import { enqueueGoogleSync } from '../services/google/dispatch.js';
import { createCalendarMeetRoom } from '../services/meet/booking-meet.js';
import { getStoredMeetSettings } from '../services/meet/settings.js';
import { meetEnabled } from '../services/meet/token-service.js';
import { enqueue } from '../services/scheduling/queue.js';
import type { ICalendarEvent } from '../models/CalendarEvent.js';
import type { FastifyBaseLogger } from 'fastify';

/** Encola UNA invitación por attendee. `skip` = emails ya invitados (en PATCH, los previos → sólo se
 *  invita a los NUEVOS; review B). jobId idempotente + email normalizado a lowercase (review B — MED).
 *  Best-effort: un fallo de encolado NO aborta la operación (el evento ya se guardó). */
async function enqueueInvites(
  event: ICalendarEvent,
  log: FastifyBaseLogger,
  skip?: Set<string>
): Promise<void> {
  for (const a of event.attendees ?? []) {
    const email = a.email.toLowerCase();
    if (skip?.has(email)) continue;
    try {
      await enqueue(
        'send-event-invite',
        { eventId: event._id.toString(), email },
        { jobId: `event-invite-${event._id.toString()}-${email}` }
      );
    } catch (err) {
      log.warn(`[calendar] no se pudo encolar la invitación a ${email}: ${(err as Error).message}`);
    }
  }
}

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i);

const eventBodySchema = z.object({
  accountId: objectIdSchema,
  calendarId: z.string().min(1),
  calendarName: z.string().min(1),
  calendarColor: z.string().optional(),
  uid: z.string().min(1),
  summary: z.string().min(1).max(1024),
  description: z.string().max(8192).optional(),
  location: z.string().max(1024).optional(),
  // Invitados (estilo Google): lista de emails con nombre opcional.
  attendees: z
    .array(z.object({ name: z.string().max(200).optional(), email: z.string().email() }))
    .max(100)
    .optional(),
  // Toggle "con Bifrost Meet": crea una sala y pega el link en el evento.
  withMeet: z.boolean().optional(),
  startDate: z.string().datetime(),
  startTimezone: z.string().default('UTC'),
  endDate: z.string().datetime(),
  endTimezone: z.string().default('UTC'),
  allDay: z.boolean().default(false),
  recurrenceRule: z.string().optional(),
  recurrenceExceptions: z.array(z.string()).optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).default('confirmed'),
});

export default function calendarRoutes(fastify: FastifyInstance) {
  // El rango [start,end] es OBLIGATORIO y acotado: sin él, GET /calendar devolvía TODO el histórico
  // del usuario (vector de abuso/escala — un cliente autenticado podía pedir años repetidamente bajo
  // el rate-limit). Ventana máxima 366 días (cubre día/semana/mes con holgura). Review B.
  const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
  const rangeSchema = z
    .object({ start: z.string().datetime(), end: z.string().datetime() })
    .refine((q) => new Date(q.end).getTime() > new Date(q.start).getTime(), {
      message: 'end debe ser posterior a start',
    })
    .refine((q) => new Date(q.end).getTime() - new Date(q.start).getTime() <= MAX_RANGE_MS, {
      message: 'rango demasiado grande (máx 366 días)',
    });

  fastify.get('/', async (request, reply) => {
    const parsed = rangeSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'start y end requeridos (≤366 días)',
      });
    }
    const { start, end } = parsed.data;
    // Solapamiento REAL con el rango [start,end]: el evento empieza antes del fin Y termina
    // después del inicio. Antes se filtraba sólo por startDate dentro del rango, lo que dejaba
    // afuera eventos que cruzan el borde (empiezan antes del mes y terminan dentro) — review B.
    const events = await CalendarEvent.find({
      userId: request.user.userId,
      startDate: { $lte: new Date(end) },
      endDate: { $gte: new Date(start) },
      // Los tombstones pendientes de borrado en Google (delete manual ya confirmado al usuario) no
      // deben seguir viéndose en el calendario mientras el sync los elimina.
      googleSyncStatus: { $ne: 'deleting' },
    }).sort({ startDate: 1 });
    return events.map(serializeCalendarEvent);
  });

  fastify.post('/', async (request, reply) => {
    const body = eventBodySchema.parse(request.body);
    await requireOwnedAccount(request.user.userId, body.accountId);
    // Invariante fin>inicio también en create (antes sólo se validaba en PATCH) — review B.
    if (new Date(body.endDate).getTime() <= new Date(body.startDate).getTime()) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'endDate must be after startDate',
      });
    }
    const { withMeet, attendees, ...eventFields } = body;
    const event = await CalendarEvent.create({
      ...eventFields,
      // Invitados: email a lowercase (dedup/lookup consistente) + estado/rol default (Google-like).
      attendees: attendees?.map((a) => ({
        name: a.name,
        email: a.email.toLowerCase(),
        status: 'needs-action',
        role: 'required',
      })),
      userId: request.user.userId,
      startDate: new Date(body.startDate),
      endDate: new Date(body.endDate),
      // 'pending' sólo si la feature está activa → el reconciler puede rastrear un enqueue perdido.
      googleSyncStatus: (await googleEnabled()) ? 'pending' : undefined,
    });
    // Toggle "con Meet": crea la sala y pega el link (degradado si Meet está off o falla — nunca aborta).
    if (withMeet) {
      const settings = await getStoredMeetSettings();
      if (meetEnabled(settings)) {
        try {
          const room = await createCalendarMeetRoom({
            calendarEventId: event._id,
            userId: new Types.ObjectId(request.user.userId),
            name: body.summary,
            endAt: new Date(body.endDate),
            settings,
          });
          event.meetRoomId = room.meetRoomId;
          event.meetUrl = room.meetUrl;
          await event.save();
        } catch (err) {
          request.log.warn(
            `[calendar] no se pudo crear la sala Meet del evento (evento creado sin Meet): ${(err as Error).message}`
          );
        }
      }
    }
    await enqueueInvites(event, request.log); // invitaciones por email a los attendees (best-effort)
    await enqueueGoogleSync(event._id); // sync a Google (no-op si la feature está apagada; fail-soft)
    return serializeCalendarEvent(event);
  });

  fastify.get('/:eventId', async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    objectIdSchema.parse(eventId);
    const event = await CalendarEvent.findOne({ _id: eventId, userId: request.user.userId });
    if (!event) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
    }
    return serializeCalendarEvent(event);
  });

  fastify.patch('/:eventId', async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    objectIdSchema.parse(eventId);
    const body = eventBodySchema.partial().parse(request.body);
    if (body.accountId) {
      await requireOwnedAccount(request.user.userId, body.accountId);
    }
    // Owner-bound: leer el evento del propio usuario (404 si no existe / es de otro).
    const existing = await CalendarEvent.findOne({ _id: eventId, userId: request.user.userId });
    if (!existing) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
    }
    // Los eventos importados de Google (source:'google') son READ-ONLY en Bifrost: se editan en Google
    // (fuente de verdad). Enforcement en el BACKEND, no sólo ocultando el botón (review B/D bidireccional).
    if (existing.source === 'google') {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Los eventos de Google se editan en Google Calendar.',
        code: 'GOOGLE_READONLY',
      });
    }
    // Invariante fin>inicio validada contra las fechas EFECTIVAS (las nuevas que vengan + las
    // existentes para las que no), no sólo cuando llegan ambas — así un PATCH parcial no puede
    // dejar el evento inválido contra su otra fecha ya guardada (review B).
    const effStart = body.startDate ? new Date(body.startDate) : existing.startDate;
    const effEnd = body.endDate ? new Date(body.endDate) : existing.endDate;
    if (effEnd.getTime() <= effStart.getTime()) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'endDate must be after startDate',
      });
    }
    const { withMeet, attendees: patchAttendees, ...patchFields } = body;
    const update: Record<string, unknown> = { ...patchFields };
    // Invitados: normalizados con estado/rol por default (consistente con el create).
    if (patchAttendees) {
      update.attendees = patchAttendees.map((a) => ({
        name: a.name,
        email: a.email.toLowerCase(),
        status: 'needs-action',
        role: 'required',
      }));
    }
    if (body.startDate) update.startDate = new Date(body.startDate);
    if (body.endDate) update.endDate = new Date(body.endDate);
    // La edición debe re-reflejarse en Google: 'pending' hace rastreable un enqueue perdido.
    if (await googleEnabled()) update.googleSyncStatus = 'pending';

    // Escritura ATÓMICA y PARCIAL ($set sólo de los campos del body): evita el lost-update de un
    // read-modify-write con save() (que reescribiría el doc entero y pisaría cambios concurrentes en
    // campos ajenos al PATCH). El findOne previo es sólo para validar el invariante (review D).
    const event = await CalendarEvent.findOneAndUpdate(
      { _id: eventId, userId: request.user.userId },
      { $set: update },
      { new: true }
    );
    if (!event) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
    }
    // withMeet en PATCH: agregar sala a un evento que aún no tiene (review B — MED: no descartar el flag).
    // Idempotente por el índice único de `calendarEventId`; degradado si Meet off o falla.
    if (withMeet && !event.meetRoomId) {
      const settings = await getStoredMeetSettings();
      if (meetEnabled(settings)) {
        try {
          const room = await createCalendarMeetRoom({
            calendarEventId: event._id,
            userId: new Types.ObjectId(request.user.userId),
            name: event.summary,
            endAt: event.endDate,
            settings,
          });
          event.meetRoomId = room.meetRoomId;
          event.meetUrl = room.meetUrl;
          await event.save();
        } catch (err) {
          request.log.warn(
            `[calendar] no se pudo crear la sala Meet al editar (evento sin Meet): ${(err as Error).message}`
          );
        }
      }
    }
    // Sólo si la edición cambió los invitados: invita a los NUEVOS (los previos van en `skip` → no se
    // re-invita a nadie ya invitado, sin depender del dedup del jobId — review B).
    if (patchAttendees) {
      const prev = new Set((existing.attendees ?? []).map((a) => a.email.toLowerCase()));
      await enqueueInvites(event, request.log, prev);
    }
    await enqueueGoogleSync(event._id); // refleja la edición en Google (fail-soft)
    return serializeCalendarEvent(event);
  });

  fastify.delete('/:eventId', async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    objectIdSchema.parse(eventId);
    // Con Google configurado NO se borra en duro: se deja un TOMBSTONE (cancelled + 'deleting')
    // ATÓMICAMENTE y el sync lo borra en Google (por id determinista, idempotente) y RECIÉN AHÍ elimina
    // el doc local (evita huérfanos en Google). Se tombstonea SIEMPRE —no sólo si ya tiene googleEventId—
    // porque un evento aún 'pending' (sync en vuelo, id no guardado todavía) igual puede terminar en
    // Google; el motor de sync resuelve el resto (si nunca se creó, el 404 del delete es un no-op).
    // `googleDeletePending` marca el borrado bidireccional para que el POLLER (import Google→Bifrost) no
    // re-cree el evento entre el tombstone y la confirmación del delete remoto (review B/D). Es inocuo para
    // los Bifrost-origen (el poller sólo importa source:'google').
    const tomb = (await googleEnabled())
      ? await CalendarEvent.findOneAndUpdate(
          { _id: eventId, userId: request.user.userId },
          { $set: { status: 'cancelled', googleSyncStatus: 'deleting', googleDeletePending: true } }
        )
      : null;
    if (tomb) {
      await enqueueGoogleSync(tomb._id);
      return { ok: true };
    }
    // Nunca sincronizado (o feature apagada): borrado directo.
    const result = await CalendarEvent.deleteOne({ _id: eventId, userId: request.user.userId });
    if (result.deletedCount === 0) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
    }
    return { ok: true };
  });
}
