import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/authz.js';
import { getStorageConfigPublic, setStorageConfig } from '../services/storage/index.js';
import { isSafeS3Endpoint, verifyS3Connection } from '../services/storage/s3.js';
import { getBranding, setBranding, toPublicBranding } from '../services/branding.js';
import { loginOrRegister } from '../services/auth.js';
import { checkForUpdate } from '../services/update-check.js';
import { BUILD_INFO } from '../lib/buildInfo.js';
import { User } from '../models/User.js';
import { Account } from '../models/Account.js';
import { Email } from '../models/Email.js';
import { Folder } from '../models/Folder.js';
import { AttachmentBlob } from '../models/AttachmentBlob.js';
import { Draft } from '../models/Draft.js';
import { Contact } from '../models/Contact.js';
import { CalendarEvent } from '../models/CalendarEvent.js';
import { Booking, serializeBooking } from '../models/Booking.js';
import { EventType } from '../models/EventType.js';
import { getSchedulingSettings, setSchedulingSettings } from '../services/scheduling/settings.js';
import {
  getCalendarSettings,
  setCalendarSettings,
  CalendarSettingsError,
} from '../services/calendar-settings.js';
import { getStorageDefaults, setStorageDefaults } from '../services/storage-defaults.js';
import { Group, serializeGroup, type IGroup } from '../models/Group.js';
import { isValidZone } from '../lib/scheduling/time.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'id inválido');
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// Logo como data URL base64 (sin SVG: un SVG podría traer scripts; aunque en <img> no ejecutan,
// lo excluimos por defensa en profundidad). Cap de ~256KB decodificados para no inflar el doc.
const LOGO_MAX_BYTES = 256 * 1024;
const logoDataUrl = z
  .string()
  .regex(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/, 'logo inválido')
  .refine((v) => {
    const b64 = v.slice(v.indexOf(',') + 1);
    return Math.floor((b64.length * 3) / 4) <= LOGO_MAX_BYTES;
  }, 'el logo supera 256KB');

const brandingSchema = z
  .object({
    companyName: z.string().trim().max(60).optional(),
    tagline: z.string().trim().max(80).optional(),
    accentColor: z.string().regex(HEX, 'color inválido').optional(),
    // '' o null LIMPIAN el logo; un data URL válido lo fija; ausente = no tocar.
    logoDataUrl: z.union([logoDataUrl, z.literal(''), z.null()]).optional(),
  })
  .strict();

// Alta de cuenta por el admin (mismo contrato que el login + cuota/nombre). El backend verifica
// las credenciales IMAP reales antes de crear (createAccount reusa loginOrRegister).
const createAccountSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
    displayName: z.string().trim().max(120).optional(),
    imapHost: z.string().min(1),
    imapPort: z.number().int().min(1).max(65535),
    imapSecure: z.boolean(),
    smtpHost: z.string().min(1),
    smtpPort: z.number().int().min(1).max(65535),
    smtpSecure: z.boolean(),
    quotaBytes: z.number().int().min(0).optional(),
  })
  .strict();

const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    quotaBytes: z.number().int().min(0).optional(),
    // El admin sólo conmuta active⇄disabled; 'syncing'/'error' los maneja el sistema.
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

// `local` (sin config) o `s3` (endpoint opcional + bucket/region/keys; el secret se cifra al
// persistir). Union discriminada → `.strict()` rechaza campos extra y mezclas inválidas.
const storageConfigSchema = z.discriminatedUnion('providerType', [
  z.object({ providerType: z.literal('local') }).strict(),
  z
    .object({
      providerType: z.literal('s3'),
      s3: z
        .object({
          // Endpoint estructuralmente seguro: sólo http/https, sin userinfo/query/fragment/path
          // ni IP de metadata cloud (ver isSafeS3Endpoint). Rechaza ftp://, file://, etc.
          endpoint: z.string().url().refine(isSafeS3Endpoint, 'endpoint S3 inválido').optional(),
          bucket: z.string().min(1),
          // region se interpola en la URL del host AWS por defecto → restringimos al charset
          // de región (evita inyección de host/query/path).
          region: z
            .string()
            .min(1)
            .regex(/^[a-z0-9-]+$/, 'región inválida'),
          accessKeyId: z.string().min(1),
          secretAccessKey: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);

/**
 * Rutas del panel de administración. TODO lo de acá exige rol `admin` (verificado en DB,
 * no por el claim del JWT). Por ahora sólo un endpoint de sondeo; los PRs siguientes suman
 * la config de providers (storage, provisión de buzones, etc.). El feature-gating real vive
 * acá (backend), no sólo en la UI.
 */
export default function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request) => {
    await requireAdmin(request.user.userId);
  });

  // Sondeo: confirma que el solicitante es admin (la UI lo usa para mostrar /admin).
  fastify.get('/whoami', () => {
    return { role: 'admin' as const };
  });

  // Build de la imagen API (admin-only — NO en /health público para no facilitar fingerprinting).
  fastify.get('/version', () => BUILD_INFO);

  // Chequeo de actualización (estilo WordPress): compara el build instalado con el último publicado
  // en GitHub. Sólo lectura (Fase 1). `?force=1` salta el cache. Admin-only (preHandler de arriba).
  fastify.get('/update/check', async (request) => {
    const { force } = z.object({ force: z.enum(['1', 'true']).optional() }).parse(request.query);
    return checkForUpdate(force !== undefined);
  });

  // Config del storage de adjuntos (wizard Paso 1). GET sin secretos.
  fastify.get('/config/storage', async () => {
    return getStorageConfigPublic();
  });

  fastify.patch('/config/storage', async (request) => {
    const body = storageConfigSchema.parse(request.body);
    return setStorageConfig(body, request.user.userId);
  });

  // Probar la conexión S3 sin persistir: el admin verifica credenciales/bucket ANTES de activar
  // S3 y romper los uploads de todos con un typo. Hace un round-trip real (put→get→delete).
  const s3TestSchema = z
    .object({
      endpoint: z.string().url().refine(isSafeS3Endpoint, 'endpoint S3 inválido').optional(),
      bucket: z.string().min(1),
      region: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/, 'región inválida'),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
    })
    .strict();

  fastify.post('/config/storage/test', async (request, reply) => {
    const s3 = s3TestSchema.parse(request.body);
    try {
      await verifyS3Connection(s3);
    } catch {
      // No filtramos el detalle crudo del provider (podría incluir info sensible del request).
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'No se pudo conectar al bucket S3 con esos datos. Revisá endpoint/credenciales.',
      });
    }
    return { ok: true };
  });

  // ---- Branding (white-label en runtime) ----
  // GET con metadatos de auditoría (updatedBy/At) para el panel; la vista pública SIN auth vive en
  // /api/branding.
  fastify.get('/config/branding', async () => {
    const cfg = await getBranding();
    return { ...toPublicBranding(cfg), updatedBy: cfg.updatedBy, updatedAt: cfg.updatedAt };
  });

  fastify.put('/config/branding', async (request) => {
    const body = brandingSchema.parse(request.body);
    const cfg = await setBranding(body, request.user.userId);
    return { ...toPublicBranding(cfg), updatedBy: cfg.updatedBy, updatedAt: cfg.updatedAt };
  });

  // ---- Agenda Inteligente (config de empresa + auditoría de reservas) ----
  const schedulingSettingsSchema = z
    .object({
      enabled: z.boolean().optional(),
      publicLinksEnabled: z.boolean().optional(),
      defaults: z
        .object({
          timezone: z.string().refine(isValidZone, 'tz inválida').optional(),
          durationMinutes: z.number().int().min(5).max(480).optional(),
          dateRangeDays: z.number().int().min(1).max(365).optional(),
        })
        .strict()
        .optional(),
      maxEventTypesPerUser: z.number().int().min(1).max(100).optional(),
      auditEnabled: z.boolean().optional(),
    })
    .strict();

  fastify.get('/scheduling/settings', async () => {
    return getSchedulingSettings();
  });

  fastify.patch('/scheduling/settings', async (request) => {
    const body = schedulingSettingsSchema.parse(request.body);
    return setSchedulingSettings(body);
  });

  // ───────── Preferencias de calendario (F5) ─────────
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const calendarSettingsSchema = z
    .object({
      timezone: z.string().refine(isValidZone, 'zona horaria inválida').optional(),
      weekStart: z.union([z.literal(0), z.literal(1)]).optional(),
      dayStart: z.string().regex(HHMM, 'hora inválida (HH:MM)').optional(),
      dayEnd: z.string().regex(HHMM, 'hora inválida (HH:MM)').optional(),
      defaultDurationMin: z.number().int().min(5).max(480).optional(),
      defaultView: z.enum(['day', 'week', 'month']).optional(),
      showWeekends: z.boolean().optional(),
      autoInvite: z.boolean().optional(),
      syncAgenda: z.boolean().optional(),
    })
    .strict();

  // ───────── Almacenamiento: defaults de cuenta (F6) ─────────
  const storageDefaultsSchema = z.object({ defaultQuotaBytes: z.number().int().min(0) }).strict();
  fastify.get('/config/storage-defaults', async () => {
    return getStorageDefaults();
  });
  fastify.patch('/config/storage-defaults', async (request) => {
    const body = storageDefaultsSchema.parse(request.body);
    return setStorageDefaults(body);
  });

  // ───────── Grupos (F7) ─────────
  // Valida que los `ids` sean usuarios EXISTENTES y los devuelve deduplicados; si alguno no existe,
  // responde 400 y devuelve null (el caller corta). Integridad de referencias (review B/C/D).
  async function resolveExistingMembers(
    ids: string[],
    reply: import('fastify').FastifyReply
  ): Promise<string[] | null> {
    const uniq = [...new Set(ids)];
    if (uniq.length === 0) return [];
    const found = await User.find({ _id: { $in: uniq } })
      .select('_id')
      .lean();
    const foundSet = new Set(found.map((u) => u._id.toString()));
    const missing = uniq.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'Algún miembro no existe' });
      return null;
    }
    return uniq;
  }
  function isDupKey(e: unknown): boolean {
    return (e as { code?: number }).code === 11000;
  }
  const MAX_GROUP_MEMBERS = 5000; // cota dura del tamaño del array (review D-040)
  /** Serializa filtrando miembros a usuarios existentes — MISMO criterio que el GET (consistencia, review C). */
  async function serializeGroupFiltered(g: IGroup): Promise<ReturnType<typeof serializeGroup>> {
    const ids = g.memberUserIds.map((id) => id.toString());
    if (ids.length === 0) return serializeGroup(g, []);
    const existing = await User.find({ _id: { $in: ids } })
      .select('_id')
      .lean();
    const set = new Set(existing.map((u) => u._id.toString()));
    return serializeGroup(
      g,
      ids.filter((id) => set.has(id))
    );
  }
  const groupCreateSchema = z
    .object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional(),
      color: z.string().regex(HEX, 'color inválido').optional(),
      email: z.union([z.string().email(), z.literal('')]).optional(),
      memberUserIds: z.array(objectId).max(2000).optional(),
    })
    .strict();
  const groupPatchSchema = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(500).optional(),
      color: z.string().regex(HEX, 'color inválido').optional(),
      email: z.union([z.string().email(), z.literal('')]).optional(),
    })
    .strict();

  /** Lista grupos; FILTRA miembros a usuarios existentes al leer (defensa ante usuarios borrados). */
  fastify.get('/groups', async () => {
    const groups = await Group.find().sort({ name: 1 });
    const allIds = [...new Set(groups.flatMap((g) => g.memberUserIds.map((id) => id.toString())))];
    const existing = allIds.length
      ? await User.find({ _id: { $in: allIds } })
          .select('_id')
          .lean()
      : [];
    const existingSet = new Set(existing.map((u) => u._id.toString()));
    return {
      groups: groups.map((g) =>
        serializeGroup(
          g,
          g.memberUserIds.map((id) => id.toString()).filter((id) => existingSet.has(id))
        )
      ),
    };
  });

  fastify.post('/groups', async (request, reply) => {
    const body = groupCreateSchema.parse(request.body);
    const members = await resolveExistingMembers(body.memberUserIds ?? [], reply);
    if (members === null) return;
    const email = body.email && body.email.length > 0 ? body.email : undefined;
    try {
      const g = await Group.create({
        name: body.name,
        description: body.description,
        color: body.color,
        email,
        memberUserIds: members,
      });
      reply.code(201);
      return await serializeGroupFiltered(g);
    } catch (e) {
      if (isDupKey(e)) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Ya existe un grupo con ese nombre o email',
        });
      }
      throw e;
    }
  });

  fastify.patch('/groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    objectId.parse(id);
    const body = groupPatchSchema.parse(request.body);
    const set: Record<string, unknown> = {};
    const unset: Record<string, unknown> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.description !== undefined) set.description = body.description;
    if (body.color !== undefined) set.color = body.color;
    if (body.email !== undefined) {
      // '' limpia el email (→ $unset, para no chocar con el índice parcial único).
      if (body.email === '') unset.email = 1;
      else set.email = body.email;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    try {
      const g = await Group.findByIdAndUpdate(id, update, { new: true });
      if (!g)
        return await reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'Grupo no encontrado' });
      return await serializeGroupFiltered(g);
    } catch (e) {
      if (isDupKey(e)) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Ya existe un grupo con ese nombre o email',
        });
      }
      throw e;
    }
  });

  /** Miembros vía $addToSet/$pull (NUNCA replace del array → unicidad atómica + sin lost-update, review C). */
  fastify.patch('/groups/:id/members', async (request, reply) => {
    const { id } = request.params as { id: string };
    objectId.parse(id);
    const body = z
      .object({
        add: z.array(objectId).max(2000).optional(),
        remove: z.array(objectId).max(2000).optional(),
      })
      .strict()
      .parse(request.body);
    if (body.add?.length) {
      const ok = await resolveExistingMembers(body.add, reply);
      if (ok === null) return;
      // Cota dura del tamaño final del array (review B/D-040): no permitir que crezca sin techo.
      const current = await Group.findById(id).select('memberUserIds').lean();
      if (!current)
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'Grupo no encontrado' });
      const currentIds = new Set(current.memberUserIds.map((m) => m.toString()));
      const net = ok.filter((m) => !currentIds.has(m)).length;
      if (currentIds.size + net > MAX_GROUP_MEMBERS) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: `Máximo ${String(MAX_GROUP_MEMBERS)} miembros por grupo`,
        });
      }
      await Group.updateOne({ _id: id }, { $addToSet: { memberUserIds: { $each: ok } } });
    }
    if (body.remove?.length) {
      await Group.updateOne({ _id: id }, { $pull: { memberUserIds: { $in: body.remove } } });
    }
    const g = await Group.findById(id);
    if (!g)
      return await reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Grupo no encontrado' });
    return await serializeGroupFiltered(g);
  });

  fastify.delete('/groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    objectId.parse(id);
    const g = await Group.findByIdAndDelete(id);
    if (!g)
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Grupo no encontrado' });
    return { ok: true };
  });

  fastify.get('/config/calendar', async () => {
    return getCalendarSettings();
  });

  fastify.patch('/config/calendar', async (request, reply) => {
    const patch = calendarSettingsSchema.parse(request.body);
    // La validación del invariante (end>start sobre el merge) vive en el servicio, con su misma
    // lectura de `current` → cierra el TOCTOU de dos PATCH concurrentes (review B-MED).
    try {
      return await setCalendarSettings(patch);
    } catch (e) {
      if (e instanceof CalendarSettingsError) {
        return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: e.message });
      }
      throw e;
    }
  });

  // Auditoría de reservas (A2): lista global con filtros y paginación. Sólo lectura.
  const auditQuery = z.object({
    status: z.enum(['confirmed', 'cancelled', 'rescheduled']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    userId: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    skip: z.coerce.number().int().min(0).default(0),
  });
  fastify.get('/scheduling/bookings', async (request, reply) => {
    // `auditEnabled` (review B-LOW): si el admin apagó la auditoría, el listado no se expone.
    const settings = await getSchedulingSettings();
    if (!settings.auditEnabled) {
      return reply
        .code(403)
        .send({ statusCode: 403, error: 'Forbidden', message: 'Auditoría deshabilitada' });
    }
    const q = auditQuery.parse(request.query);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.userId) filter.userId = q.userId;
    if (q.from ?? q.to) {
      const range: Record<string, Date> = {};
      if (q.from) range.$gte = new Date(q.from);
      if (q.to) range.$lte = new Date(q.to);
      filter.startAt = range;
    }
    const [total, docs] = await Promise.all([
      Booking.countDocuments(filter),
      Booking.find(filter).sort({ startAt: -1 }).skip(q.skip).limit(q.limit),
    ]);
    return { total, limit: q.limit, skip: q.skip, bookings: docs.map(serializeBooking) };
  });

  // Resumen para el panel (A1): totales rápidos.
  fastify.get('/scheduling/summary', async () => {
    const [eventTypes, confirmed, cancelled, hostsWithUsername] = await Promise.all([
      EventType.countDocuments({ active: true }),
      Booking.countDocuments({ status: 'confirmed' }),
      Booking.countDocuments({ status: 'cancelled' }),
      User.countDocuments({ username: { $type: 'string' } }),
    ]);
    return { eventTypes, confirmed, cancelled, hostsWithUsername };
  });

  // ---- Gestión de cuentas (Roundcube administrable) ----
  // Lista todas las cuentas con su usuario, estado, cuota y uso REAL de almacenamiento de adjuntos
  // (suma de blobs del usuario) — no un número inventado.
  fastify.get('/accounts', async () => {
    const accounts = await Account.find()
      .select('email name isPrimary status lastSyncedAt quotaBytes userId')
      .sort({ createdAt: 1 })
      .lean();
    const userIds = [...new Set(accounts.map((a) => a.userId.toString()))];
    const users = await User.find({ _id: { $in: userIds } })
      .select('displayName primaryEmail role')
      .lean();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));
    // Uso por usuario = suma de bytes de sus AttachmentBlob (lo único que almacenamos nosotros;
    // el correo vive en el servidor IMAP). Un solo aggregate para todos.
    const usageAgg = await AttachmentBlob.aggregate<{ _id: unknown; used: number }>([
      { $match: { userId: { $in: accounts.map((a) => a.userId) } } },
      { $group: { _id: '$userId', used: { $sum: '$size' } } },
    ]);
    const usedByUser = new Map(usageAgg.map((u) => [String(u._id), u.used]));
    return {
      accounts: accounts.map((a) => {
        const u = userById.get(a.userId.toString());
        return {
          id: a._id.toString(),
          userId: a.userId.toString(),
          email: a.email,
          name: a.name,
          displayName: u?.displayName ?? a.name,
          role: u?.role ?? 'user',
          isPrimary: a.isPrimary,
          status: a.status,
          quotaBytes: a.quotaBytes ?? 0,
          usedBytes: usedByUser.get(a.userId.toString()) ?? 0,
          lastSyncedAt: a.lastSyncedAt ? a.lastSyncedAt.toISOString() : null,
        };
      }),
    };
  });

  // Crea una cuenta (verifica credenciales IMAP reales vía loginOrRegister antes de persistir).
  fastify.post('/accounts', async (request, reply) => {
    const body = createAccountSchema.parse(request.body);
    const { user, account, isNew } = await loginOrRegister(body);
    if (!isNew) {
      // El email ya existía: no es un alta. Avisar en vez de fingir creación.
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Ya existe una cuenta con ese email.',
      });
    }
    // Cuota: si el admin no la envía, se aplica la cuota por defecto configurada (F6). Sólo al CREAR;
    // nunca migra cuentas existentes (review C). `0` = sin límite (= comportamiento legado).
    const quotaBytes = body.quotaBytes ?? (await getStorageDefaults()).defaultQuotaBytes;
    const set: Record<string, unknown> = { quotaBytes };
    await Account.updateOne({ _id: account._id }, { $set: set });
    if (body.displayName) {
      await User.updateOne({ _id: user._id }, { $set: { displayName: body.displayName } });
    }
    return reply.code(201).send({
      id: account._id.toString(),
      email: account.email,
      status: account.status,
      quotaBytes,
    });
  });

  // Edita una cuenta: nombre, cuota y habilitar/deshabilitar. No permite que un admin se
  // deshabilite a SÍ MISMO (se dejaría afuera). El nombre vive en el usuario dueño.
  fastify.patch('/accounts/:id', async (request, reply) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const body = updateAccountSchema.parse(request.body);
    const account = await Account.findById(id).select('userId').lean();
    if (!account) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
    }
    if (body.status === 'disabled' && account.userId.toString() === request.user.userId) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'No podés deshabilitar tu propia cuenta de administrador.',
      });
    }
    const set: Record<string, unknown> = {};
    if (body.quotaBytes !== undefined) set.quotaBytes = body.quotaBytes;
    if (body.status !== undefined) set.status = body.status;
    if (Object.keys(set).length > 0) await Account.updateOne({ _id: id }, { $set: set });
    if (body.displayName) {
      await User.updateOne({ _id: account.userId }, { $set: { displayName: body.displayName } });
    }
    return { ok: true };
  });

  // Elimina una cuenta y su correo cacheado (emails/folders). Si era la última del usuario, borra
  // también el usuario. No permite borrar la cuenta del propio admin (anti auto-lockout). Los blobs
  // de adjuntos quedan para el GC (son por-usuario y mark-and-sweep).
  fastify.delete('/accounts/:id', async (request, reply) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const account = await Account.findById(id).select('userId').lean();
    if (!account) {
      return reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
    }
    if (account.userId.toString() === request.user.userId) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'No podés eliminar tu propia cuenta de administrador.',
      });
    }
    await Account.deleteOne({ _id: id });
    // Datos ACOTADOS A LA CUENTA (accountId-bound): se borran SIEMPRE, sea o no la última cuenta.
    // Incluye Drafts: así sus AttachmentBlob quedan SIN referencia y el GC mark-and-sweep los
    // reclama (docs + bytes en el storage provider) — si no, fuga de storage por blobs inmortales.
    await Promise.all([
      Email.deleteMany({ accountId: id }),
      Folder.deleteMany({ accountId: id }),
      Draft.deleteMany({ accountId: id }),
      CalendarEvent.deleteMany({ accountId: id }),
    ]);
    // Si era la ÚLTIMA cuenta del usuario, borrar también el usuario y sus datos por-usuario
    // (Contacts). Los AttachmentBlob (userId-bound) los recicla el GC al quedar sin drafts.
    const remaining = await Account.countDocuments({ userId: account.userId });
    if (remaining === 0) {
      await Promise.all([
        User.deleteOne({ _id: account.userId }),
        Contact.deleteMany({ userId: account.userId }),
      ]);
    }
    return { ok: true };
  });
}
