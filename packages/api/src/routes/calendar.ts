import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CalendarEvent, serializeCalendarEvent } from '../models/CalendarEvent.js';
import { requireOwnedAccount } from '../lib/authz.js';

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
      return reply
        .code(400)
        .send({
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
    }).sort({ startDate: 1 });
    return events.map(serializeCalendarEvent);
  });

  fastify.post('/', async (request, reply) => {
    const body = eventBodySchema.parse(request.body);
    await requireOwnedAccount(request.user.userId, body.accountId);
    // Invariante fin>inicio también en create (antes sólo se validaba en PATCH) — review B.
    if (new Date(body.endDate).getTime() <= new Date(body.startDate).getTime()) {
      return reply
        .code(400)
        .send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'endDate must be after startDate',
        });
    }
    const event = await CalendarEvent.create({
      ...body,
      userId: request.user.userId,
      startDate: new Date(body.startDate),
      endDate: new Date(body.endDate),
    });
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
    const update: Record<string, unknown> = { ...body };
    if (body.startDate) update.startDate = new Date(body.startDate);
    if (body.endDate) update.endDate = new Date(body.endDate);

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
    return serializeCalendarEvent(event);
  });

  fastify.delete('/:eventId', async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    objectIdSchema.parse(eventId);
    const result = await CalendarEvent.deleteOne({ _id: eventId, userId: request.user.userId });
    if (result.deletedCount === 0) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
    }
    return { ok: true };
  });
}
