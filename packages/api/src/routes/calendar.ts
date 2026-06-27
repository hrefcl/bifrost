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
  summary: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
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
  fastify.get('/', async (request) => {
    const query = request.query as { start?: string; end?: string };
    const filter: Record<string, unknown> = { userId: request.user.userId };
    if (query.start && query.end) {
      // Solapamiento REAL con el rango [start,end]: el evento empieza antes del fin Y termina
      // después del inicio. Antes se filtraba sólo por startDate dentro del rango, lo que dejaba
      // afuera eventos que cruzan el borde (empiezan antes del mes y terminan dentro) — review B.
      filter.startDate = { $lte: new Date(query.end) };
      filter.endDate = { $gte: new Date(query.start) };
    }
    const events = await CalendarEvent.find(filter).sort({ startDate: 1 });
    return events.map(serializeCalendarEvent);
  });

  fastify.post('/', async (request) => {
    const body = eventBodySchema.parse(request.body);
    await requireOwnedAccount(request.user.userId, body.accountId);
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
    const update: Record<string, unknown> = { ...body };
    if (body.startDate) update.startDate = new Date(body.startDate);
    if (body.endDate) update.endDate = new Date(body.endDate);

    const event = await CalendarEvent.findOneAndUpdate(
      { _id: eventId, userId: request.user.userId },
      update,
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
