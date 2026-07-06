import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Contact, serializeContact } from '../models/Contact.js';
import { parseContacts } from '../lib/contact-import.js';

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

  // Importar contactos desde vCard (.vcf) o CSV (iPhone/Google/Outlook). El cliente lee el archivo y manda
  // el texto; auto-detectamos el formato. Bulk con DEDUP por email primario (no duplica los ya existentes).
  const importSchema = z.object({
    content: z
      .string()
      .min(1)
      .max(10 * 1024 * 1024), // hasta 10 MB de texto
    format: z.enum(['vcard', 'csv']).optional(),
  });
  fastify.post('/import', async (request, reply) => {
    const { content, format } = importSchema.parse(request.body);
    let parsed;
    try {
      parsed = parseContacts(content, format);
    } catch {
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'No se pudo parsear el archivo.' });
    }
    // Sólo importables los que tengan email válido (clave de dedup + de identidad del contacto).
    const usable = parsed.filter((c) => c.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email));
    const total = parsed.length;
    if (usable.length === 0) return { total, imported: 0, skipped: total };

    // Emails ya existentes del usuario → no duplicar. Un solo query.
    const wanted = [...new Set(usable.map((c) => c.email.toLowerCase()))];
    const existing = new Set(
      (
        await Contact.find({ userId: request.user.userId, email: { $in: wanted } })
          .select('email')
          .lean()
      ).map((c) => c.email.toLowerCase())
    );
    const seen = new Set(existing);
    const toCreate = usable
      .filter((c) => {
        const key = c.email.toLowerCase();
        if (seen.has(key)) return false; // ya existe o repetido en el archivo
        seen.add(key);
        return true;
      })
      .map((c) => ({
        userId: request.user.userId,
        fullName: c.fullName,
        sortName: c.fullName.toLowerCase(),
        email: c.email.toLowerCase(),
        emails: c.emails,
        phones: c.phones,
        organization: c.organization,
        jobTitle: c.jobTitle,
        notes: c.notes,
        isFrequent: false,
        usageCount: 0,
        source: 'imported' as const,
      }));
    if (toCreate.length > 0) await Contact.insertMany(toCreate, { ordered: false });
    return { total, imported: toCreate.length, skipped: total - toCreate.length };
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
