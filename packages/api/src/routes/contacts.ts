import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Contact, serializeContact } from '../models/Contact.js';

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i);

const contactBodySchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  emails: z.array(z.object({ label: z.string(), address: z.string().email() })).optional(),
  phones: z.array(z.object({ label: z.string(), number: z.string() })).optional(),
  organization: z.string().optional(),
  jobTitle: z.string().optional(),
  notes: z.string().optional(),
});

export default function contactRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request) => {
    const contacts = await Contact.find({ userId: request.user.userId }).sort({ sortName: 1 });
    return contacts.map(serializeContact);
  });

  // Autocomplete del composer (estilo Gmail): contactos cuyo nombre o email matchea `q`. Owner-bound,
  // limitado. Escapa el regex de `q` para no inyectar (evita ReDoS/operadores). Devuelve {name,email}.
  fastify.get('/search', async (request) => {
    const q = ((request.query as { q?: string }).q ?? '').trim();
    if (q.length < 1) return [];
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    const contacts = await Contact.find({
      userId: request.user.userId,
      $or: [{ fullName: rx }, { email: rx }],
    })
      .sort({ usageCount: -1, sortName: 1 })
      .limit(8)
      .lean();
    return contacts.map((c) => ({ name: c.fullName, email: c.email }));
  });

  fastify.post('/', async (request) => {
    const body = contactBodySchema.parse(request.body);
    const contact = await Contact.create({
      userId: request.user.userId,
      ...body,
      sortName: body.fullName.toLowerCase(),
      isFrequent: false,
      usageCount: 0,
      source: 'local',
    });
    return serializeContact(contact);
  });

  fastify.get('/:contactId', async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    objectIdSchema.parse(contactId);
    const contact = await Contact.findOne({ _id: contactId, userId: request.user.userId });
    if (!contact) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Contact not found' });
    }
    return serializeContact(contact);
  });

  fastify.patch('/:contactId', async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    objectIdSchema.parse(contactId);
    const body = contactBodySchema.partial().parse(request.body);
    const update: Record<string, unknown> = { ...body };
    if (body.fullName) update.sortName = body.fullName.toLowerCase();

    const contact = await Contact.findOneAndUpdate(
      { _id: contactId, userId: request.user.userId },
      update,
      { new: true }
    );
    if (!contact) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Contact not found' });
    }
    return serializeContact(contact);
  });

  fastify.delete('/:contactId', async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    objectIdSchema.parse(contactId);
    const result = await Contact.deleteOne({ _id: contactId, userId: request.user.userId });
    if (result.deletedCount === 0) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Contact not found' });
    }
    return { ok: true };
  });
}
