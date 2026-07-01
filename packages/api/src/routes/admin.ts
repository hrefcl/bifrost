import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ForbiddenError, resolveAdminAccess, type AdminAccess } from '../lib/authz.js';
import { Role, serializeRole } from '../models/Role.js';
import { PERMISSIONS, sanitizePermissions } from '../lib/permissions.js';
import { getStorageConfigPublic, setStorageConfig } from '../services/storage/index.js';
import { isSafeS3Endpoint, verifyS3Connection } from '../services/storage/s3.js';
import { getBranding, setBranding, toPublicBranding } from '../services/branding.js';
import { loginOrRegister } from '../services/auth.js';
import { checkForUpdate } from '../services/update-check.js';
import { requestUpdate, getUpdateState, isUpdateInProgress } from '../services/update-apply.js';
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

// RBAC (F8): el acceso admin efectivo se resuelve en el preHandler y queda disponible a los handlers.
declare module 'fastify' {
  interface FastifyRequest {
    adminAccess?: AdminAccess;
  }
}

/**
 * Rutas del panel de administración (RBAC, F8). El preHandler resuelve el acceso efectivo en DB:
 *  - admin REAL → superusuario (pasa SIEMPRE, customRoleId ignorado);
 *  - role-holder → pasa sólo en rutas cuyo `config.permission` posee;
 *  - ruta SIN `config.permission` → admin-only (default-DENY / fail-closed, review B-CRITICAL: una
 *    ruta olvidada queda admin-only, nunca abierta).
 * `'ANY'` = cualquier role-holder con ≥1 permiso (rutas meta: whoami/permissions).
 */
export default function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request) => {
    const access = await resolveAdminAccess(request.user.userId);
    request.adminAccess = access;
    if (access.role === 'admin') return; // superusuario
    const required = (request.routeOptions.config as { permission?: string } | undefined)
      ?.permission;
    if (required === undefined) throw new ForbiddenError(); // ruta admin-only (default-deny)
    if (required === 'ANY') {
      if (access.permissions.size > 0) return;
      throw new ForbiddenError();
    }
    if (!access.permissions.has(required)) throw new ForbiddenError();
  });

  /** ¿El actor puede OTORGAR estos permisos? admin sí; un delegado sólo un SUBconjunto de los propios
   *  (least-privilege, cierra escalación por auto-asignación/edición — review B/D-020/022). */
  function canGrant(actor: AdminAccess | undefined, perms: string[]): boolean {
    if (actor?.role === 'admin') return true;
    return perms.every((p) => actor?.permissions.has(p) ?? false);
  }

  // Sondeo + permisos efectivos (la UI muestra /admin y filtra secciones con esto). 'ANY' = role-holders.
  fastify.get('/whoami', { config: { permission: 'ANY' } }, (request) => {
    const a = request.adminAccess;
    return { role: a?.role ?? 'user', permissions: [...(a?.permissions ?? [])] };
  });

  // Catálogo estático de permisos (para la UI de roles).
  fastify.get('/permissions', { config: { permission: 'roles.manage' } }, () => {
    return { permissions: PERMISSIONS };
  });

  // Build de la imagen API (admin-only — NO en /health público para no facilitar fingerprinting).
  fastify.get('/version', () => BUILD_INFO);

  // Chequeo de actualización (estilo WordPress): compara el build instalado con el último publicado
  // en GitHub. Sólo lectura (Fase 1). `?force=1` salta el cache. Admin-only (preHandler de arriba).
  fastify.get('/update/check', async (request) => {
    const { force } = z.object({ force: z.enum(['1', 'true']).optional() }).parse(request.query);
    return checkForUpdate(force !== undefined);
  });

  // APLICAR la actualización (Fase 2). El API NO toca Docker: deja un marker que el host-updater
  // (bifrost-update.sh, fuera del contenedor) lee y aplica con pull+up+rollback. HARDENING: el target lo
  // fija el SERVIDOR (el sha del último build), NO el cliente → no se puede pedir un tag arbitrario.
  // Rate-limit bajo (acción cara que dispara cambios en el host) + idempotente (no re-encola si está en curso).
  fastify.post(
    '/update/apply',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (isUpdateInProgress()) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Ya hay una actualización en curso',
        });
      }
      const status = await checkForUpdate(true);
      if (!status.updateAvailable || !status.latest) {
        return reply
          .code(409)
          .send({ statusCode: 409, error: 'Conflict', message: 'No hay actualización disponible' });
      }
      // El SERVIDOR elige el sha (de GitHub); el cliente no provee tag. Doble validación (acá + el host).
      const tag = requestUpdate(status.latest.sha);
      request.log.warn(
        { adminId: request.user.userId, target: tag, build: status.latest.build },
        'update Fase 2 ENCOLADO'
      );
      return { queued: true, target: tag, build: status.latest.build };
    }
  );

  // Estado del update en curso/último (lo escribe el host-updater) — para que el front lo pollee.
  fastify.get('/update/status', () => getUpdateState());

  // Config del storage de adjuntos (wizard Paso 1). GET sin secretos.
  fastify.get('/config/storage', { config: { permission: 'storage.manage' } }, async () => {
    return getStorageConfigPublic();
  });

  fastify.patch(
    '/config/storage',
    { config: { permission: 'storage.manage' } },
    async (request) => {
      const body = storageConfigSchema.parse(request.body);
      return setStorageConfig(body, request.user.userId);
    }
  );

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

  fastify.post(
    '/config/storage/test',
    { config: { permission: 'storage.manage' } },
    async (request, reply) => {
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
    }
  );

  // ---- Branding (white-label en runtime) ----
  // GET con metadatos de auditoría (updatedBy/At) para el panel; la vista pública SIN auth vive en
  // /api/branding.
  fastify.get('/config/branding', { config: { permission: 'branding.manage' } }, async () => {
    const cfg = await getBranding();
    return { ...toPublicBranding(cfg), updatedBy: cfg.updatedBy, updatedAt: cfg.updatedAt };
  });

  fastify.put(
    '/config/branding',
    { config: { permission: 'branding.manage' } },
    async (request) => {
      const body = brandingSchema.parse(request.body);
      const cfg = await setBranding(body, request.user.userId);
      return { ...toPublicBranding(cfg), updatedBy: cfg.updatedBy, updatedAt: cfg.updatedAt };
    }
  );

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

  fastify.get('/scheduling/settings', { config: { permission: 'scheduling.manage' } }, async () => {
    return getSchedulingSettings();
  });

  fastify.patch(
    '/scheduling/settings',
    { config: { permission: 'scheduling.manage' } },
    async (request) => {
      const body = schedulingSettingsSchema.parse(request.body);
      return setSchedulingSettings(body);
    }
  );

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
  fastify.get(
    '/config/storage-defaults',
    { config: { permission: 'storage.manage' } },
    async () => {
      return getStorageDefaults();
    }
  );
  fastify.patch(
    '/config/storage-defaults',
    { config: { permission: 'storage.manage' } },
    async (request) => {
      const body = storageDefaultsSchema.parse(request.body);
      return setStorageDefaults(body);
    }
  );

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
  fastify.get('/groups', { config: { permission: 'groups.manage' } }, async () => {
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

  fastify.post('/groups', { config: { permission: 'groups.manage' } }, async (request, reply) => {
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

  fastify.patch(
    '/groups/:id',
    { config: { permission: 'groups.manage' } },
    async (request, reply) => {
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
    }
  );

  /** Miembros vía $addToSet/$pull (NUNCA replace del array → unicidad atómica + sin lost-update, review C). */
  fastify.patch(
    '/groups/:id/members',
    { config: { permission: 'groups.manage' } },
    async (request, reply) => {
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
    }
  );

  fastify.delete(
    '/groups/:id',
    { config: { permission: 'groups.manage' } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      objectId.parse(id);
      const g = await Group.findByIdAndDelete(id);
      if (!g)
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'Grupo no encontrado' });
      return { ok: true };
    }
  );

  fastify.get('/config/calendar', { config: { permission: 'calendar.manage' } }, async () => {
    return getCalendarSettings();
  });

  fastify.patch(
    '/config/calendar',
    { config: { permission: 'calendar.manage' } },
    async (request, reply) => {
      const patch = calendarSettingsSchema.parse(request.body);
      // La validación del invariante (end>start sobre el merge) vive en el servicio, con su misma
      // lectura de `current` → cierra el TOCTOU de dos PATCH concurrentes (review B-MED).
      try {
        return await setCalendarSettings(patch);
      } catch (e) {
        if (e instanceof CalendarSettingsError) {
          return reply
            .code(400)
            .send({ statusCode: 400, error: 'Bad Request', message: e.message });
        }
        throw e;
      }
    }
  );

  // Auditoría de reservas (A2): lista global con filtros y paginación. Sólo lectura.
  const auditQuery = z.object({
    status: z.enum(['confirmed', 'cancelled', 'rescheduled']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    userId: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    skip: z.coerce.number().int().min(0).default(0),
  });
  fastify.get(
    '/scheduling/bookings',
    { config: { permission: 'scheduling.manage' } },
    async (request, reply) => {
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
    }
  );

  // Resumen para el panel (A1): totales rápidos.
  fastify.get('/scheduling/summary', { config: { permission: 'scheduling.manage' } }, async () => {
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
  fastify.get('/accounts', { config: { permission: 'accounts.manage' } }, async () => {
    const accounts = await Account.find()
      .select('email name isPrimary status lastSyncedAt quotaBytes userId')
      .sort({ createdAt: 1 })
      .lean();
    const userIds = [...new Set(accounts.map((a) => a.userId.toString()))];
    const users = await User.find({ _id: { $in: userIds } })
      .select('displayName primaryEmail role customRoleId')
      .lean();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));
    // Nombres de los roles custom asignados (para mostrarlos en la lista de cuentas).
    const roleIds = [...new Set(users.map((u) => u.customRoleId?.toString()).filter(Boolean))];
    const roles = roleIds.length
      ? await Role.find({ _id: { $in: roleIds } })
          .select('name')
          .lean()
      : [];
    const roleNameById = new Map(roles.map((r) => [r._id.toString(), r.name]));
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
          // RBAC: rol custom asignado (null = ninguno). Se ignora si role==='admin' (superusuario).
          customRoleId: u?.customRoleId ? u.customRoleId.toString() : null,
          customRoleName: u?.customRoleId
            ? (roleNameById.get(u.customRoleId.toString()) ?? null)
            : null,
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
  fastify.post(
    '/accounts',
    { config: { permission: 'accounts.manage' } },
    async (request, reply) => {
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
    }
  );

  // Edita una cuenta: nombre, cuota y habilitar/deshabilitar. No permite que un admin se
  // deshabilite a SÍ MISMO (se dejaría afuera). El nombre vive en el usuario dueño.
  fastify.patch(
    '/accounts/:id',
    { config: { permission: 'accounts.manage' } },
    async (request, reply) => {
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
    }
  );

  // Elimina una cuenta y su correo cacheado (emails/folders). Si era la última del usuario, borra
  // también el usuario. No permite borrar la cuenta del propio admin (anti auto-lockout). Los blobs
  // de adjuntos quedan para el GC (son por-usuario y mark-and-sweep).
  fastify.delete(
    '/accounts/:id',
    { config: { permission: 'accounts.manage' } },
    async (request, reply) => {
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
    }
  );

  // ---- Roles y permisos (RBAC, F8) ----
  // Todas gated `roles.manage`. REGLA DE SUBCONJUNTO: un delegado (no-admin) sólo puede crear/editar/
  // asignar roles cuyos permisos sean ⊆ los suyos (anti-escalación — review B/D). El admin REAL otorga
  // cualquier permiso. Los permisos entrantes se sanitizan contra el catálogo (claves stale se ignoran).
  const roleBodySchema = z
    .object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(300).optional(),
      permissions: z.array(z.string()).max(64).default([]),
    })
    .strict();
  const rolePatchSchema = z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(300).optional(),
      permissions: z.array(z.string()).max(64).optional(),
    })
    .strict();

  fastify.get('/roles', { config: { permission: 'roles.manage' } }, async () => {
    const roles = await Role.find().sort({ createdAt: 1 });
    return { roles: roles.map(serializeRole) };
  });

  fastify.post('/roles', { config: { permission: 'roles.manage' } }, async (request, reply) => {
    const body = roleBodySchema.parse(request.body);
    const perms = sanitizePermissions(body.permissions);
    if (!canGrant(request.adminAccess, perms)) {
      return reply.code(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'No podés otorgar permisos que vos no tenés.',
      });
    }
    try {
      const role = await Role.create({
        name: body.name,
        description: body.description,
        permissions: perms,
      });
      return await reply.code(201).send(serializeRole(role));
    } catch (e) {
      if (isDupKey(e)) {
        return reply
          .code(409)
          .send({
            statusCode: 409,
            error: 'Conflict',
            message: 'Ya existe un rol con ese nombre.',
          });
      }
      throw e;
    }
  });

  fastify.patch(
    '/roles/:id',
    { config: { permission: 'roles.manage' } },
    async (request, reply) => {
      const { id } = z.object({ id: objectId }).parse(request.params);
      const body = rolePatchSchema.parse(request.body);
      const role = await Role.findById(id);
      if (!role) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'Rol no encontrado' });
      }
      // Roles de sistema: sólo un admin REAL los altera (un delegado no puede tocarlos — review D).
      if (role.isSystem && request.adminAccess?.role !== 'admin') {
        return reply
          .code(403)
          .send({ statusCode: 403, error: 'Forbidden', message: 'Rol de sistema (protegido).' });
      }
      if (body.permissions !== undefined) {
        const perms = sanitizePermissions(body.permissions);
        if (!canGrant(request.adminAccess, perms)) {
          return reply.code(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'No podés otorgar permisos que vos no tenés.',
          });
        }
        role.permissions = perms;
      }
      if (body.name !== undefined) role.name = body.name;
      if (body.description !== undefined) role.description = body.description;
      try {
        await role.save();
      } catch (e) {
        if (isDupKey(e)) {
          return reply
            .code(409)
            .send({
              statusCode: 409,
              error: 'Conflict',
              message: 'Ya existe un rol con ese nombre.',
            });
        }
        throw e;
      }
      return serializeRole(role);
    }
  );

  fastify.delete(
    '/roles/:id',
    { config: { permission: 'roles.manage' } },
    async (request, reply) => {
      const { id } = z.object({ id: objectId }).parse(request.params);
      const role = await Role.findById(id).select('isSystem').lean();
      if (!role) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'Rol no encontrado' });
      }
      if (role.isSystem) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Rol de sistema (no se puede eliminar).',
        });
      }
      // CASCADE-UNSET: los usuarios con este rol quedan SIN rol (anti-lockout — nunca queda un
      // customRoleId colgando; el admin REAL nunca se ve afectado, review C/D).
      await Role.deleteOne({ _id: id });
      await User.updateMany({ customRoleId: id }, { $unset: { customRoleId: '' } });
      return { ok: true };
    }
  );

  // Asigna (customRoleId) o quita (null) un rol a la cuenta objetivo. Gated `roles.manage` + regla de
  // subconjunto. NO toca `User.role` (admin sólo por CLI). Asignar a un admin REAL es no-op efectivo
  // (el resolve ignora el rol custom del admin).
  fastify.patch(
    '/accounts/:id/role',
    { config: { permission: 'roles.manage' } },
    async (request, reply) => {
      const { id } = z.object({ id: objectId }).parse(request.params);
      const { customRoleId } = z
        .object({ customRoleId: z.union([objectId, z.null()]) })
        .strict()
        .parse(request.body);
      const account = await Account.findById(id).select('userId').lean();
      if (!account) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'Cuenta no encontrada' });
      }
      if (customRoleId === null) {
        await User.updateOne({ _id: account.userId }, { $unset: { customRoleId: '' } });
        return { ok: true };
      }
      const role = await Role.findById(customRoleId).select('permissions').lean();
      if (!role) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'Rol no encontrado' });
      }
      // Un delegado no puede asignar un rol con permisos que él no posee (escalar vía asignación).
      if (!canGrant(request.adminAccess, sanitizePermissions(role.permissions))) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'No podés asignar un rol con permisos que vos no tenés.',
        });
      }
      await User.updateOne({ _id: account.userId }, { $set: { customRoleId } });
      return { ok: true };
    }
  );
}
