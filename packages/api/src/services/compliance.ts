import mongoose from 'mongoose';
import { redis } from '../config/redis.js';
import {
  ComplianceDocument,
  type IComplianceDocument,
  type ComplianceEnforcement,
} from '../models/ComplianceDocument.js';
import {
  ComplianceVersion,
  type IComplianceVersion,
  type IComplianceLocaleContent,
} from '../models/ComplianceVersion.js';
import { ComplianceAcceptance } from '../models/ComplianceAcceptance.js';
import { ComplianceSettings } from '../models/ComplianceSettings.js';
import {
  ComplianceAdminAction,
  type ComplianceAdminActionType,
} from '../models/ComplianceAdminAction.js';
import {
  signEvidence,
  verifyEvidence,
  computeContentHash,
  type EvidenceFields,
} from '../lib/complianceHmac.js';
import { renderComplianceMarkdown } from '../lib/complianceMarkdown.js';
import { counters } from '../lib/metrics.js';

/**
 * Servicio de Compliance (DESIGN v4 §4) — ÚNICO write-path legítimo de las colecciones compliance.
 * `Model.bulkWrite()` y `db.collection()` están prohibidos fuera de aquí (no disparan los middlewares
 * de inmutabilidad). Cubre: versionado, publish standalone-safe, recomputeDenorm + promoción lazy,
 * gating de 1 colección, aceptación idempotente con evidencia HMAC, y auditoría de acciones admin.
 */

export class ComplianceError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, statusCode = 400, code = 'COMPLIANCE_ERROR') {
    super(message);
    this.name = 'ComplianceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function now(): Date {
  return new Date();
}

function isEnforcementDisabled(): boolean {
  return process.env.COMPLIANCE_ENFORCEMENT_DISABLED === '1';
}

// ───────────────────────── Epoch (invalidación de caché del gate) ─────────────────────────

function epochRedisKey(tenantId: string): string {
  return `compliance:epoch:${tenantId}`;
}

/** Incrementa el epoch (Mongo fuente de verdad) y lo espeja en Redis para invalidación cross-worker. */
export async function bumpEpoch(tenantId: string): Promise<number> {
  const doc = await ComplianceSettings.findOneAndUpdate(
    { tenantId },
    { $inc: { complianceEpoch: 1 } },
    { new: true, upsert: true }
  ).lean();
  const epoch = doc.complianceEpoch;
  try {
    // TTL de 30s (DESIGN §3.6): aunque dos bumps se crucen y Redis quede momentáneamente con un valor
    // viejo/menor, el espejo se reconstruye desde Mongo al expirar → staleness acotada (B P1 MEDIUM).
    await redis.set(epochRedisKey(tenantId), String(epoch), 'EX', 30);
  } catch {
    // Redis caído: el epoch en Mongo sigue siendo la verdad; el snapshot expira por TTL.
  }
  return epoch;
}

/** Lee el epoch actual (Redis rápido; fallback a Mongo). */
export async function getEpoch(tenantId: string): Promise<number> {
  try {
    const v = await redis.get(epochRedisKey(tenantId));
    if (v !== null) return Number(v);
  } catch {
    /* fallback Mongo */
  }
  const doc = await ComplianceSettings.findOne({ tenantId }).select('complianceEpoch').lean();
  return doc?.complianceEpoch ?? 0;
}

// ───────────────────────── recomputeDenorm (caché derivada de las versiones) ─────────────────────────

// Sólo current*/next* van en el set incondicional (pueden subir o bajar legítimamente, p.ej. expiración).
// `latestPublished*` y `enforced*` son MONOTÓNICOS: se elevan aparte con guard atómico, así un recompute
// concurrente nunca baja el watermark monótono ni revierte el bloqueo del admin (B P1b HIGH-1 / D-032).
interface DenormState {
  currentVersionId: mongoose.Types.ObjectId | null;
  currentVersionNumber: number;
  currentContentHash: string;
  currentEffectiveAt: Date | null;
  currentExpiresAt: Date | null;
  nextVersionId: mongoose.Types.ObjectId | null;
  nextVersionNumber: number;
  nextEffectiveAt: Date | null;
  nextContentHash: string;
  nextRequiresReacceptance: boolean;
}

function isInForce(v: { effectiveAt: Date; expiresAt?: Date | null }, at: Date): boolean {
  return v.effectiveAt <= at && (v.expiresAt == null || v.expiresAt > at);
}

/**
 * Recalcula la denormalización de un documento desde sus versiones PUBLICADAS (fuente de verdad).
 * Idempotente. `enforcedVersion` es monotónico no decreciente (preserva el previo del documento).
 */
export async function recomputeDenorm(
  documentId: mongoose.Types.ObjectId | string,
  opts?: { authoritative?: boolean }
): Promise<void> {
  const authoritative = opts?.authoritative === true;
  const docObjId =
    typeof documentId === 'string' ? new mongoose.Types.ObjectId(documentId) : documentId;
  const doc = await ComplianceDocument.findById(docObjId).lean();
  if (!doc) return;
  const versions = await ComplianceVersion.find({ documentId: docObjId, status: 'published' })
    .sort({ version: 1 })
    .lean();
  const at = now();

  const inForce = versions.filter((v) => isInForce(v, at));
  // current = vigente con mayor effectiveAt, tie-break mayor versión.
  const current = inForce.reduce<(typeof versions)[number] | null>((best, v) => {
    if (!best) return v;
    if (v.effectiveAt.getTime() !== best.effectiveAt.getTime())
      return v.effectiveAt > best.effectiveAt ? v : best;
    return v.version > best.version ? v : best;
  }, null);

  // next = publicada con MENOR effectiveAt > now (próximo evento temporal), tie-break MAYOR versión.
  const future = versions.filter((v) => v.effectiveAt > at);
  const next = future.reduce<(typeof versions)[number] | null>((best, v) => {
    if (!best) return v;
    if (v.effectiveAt.getTime() !== best.effectiveAt.getTime())
      return v.effectiveAt < best.effectiveAt ? v : best;
    return v.version > best.version ? v : best;
  }, null);

  const latest = versions.reduce<(typeof versions)[number] | null>(
    (best, v) => (!best || v.version > best.version ? v : best),
    null
  );
  // `latestPublishedEffectiveAt` = MAYOR effectiveAt entre publicadas (NO el de la última versión):
  // es el umbral del invariante monótono (B P1 HIGH-1).
  const maxEffectiveAt = versions.reduce<Date | null>(
    (best, v) => (!best || v.effectiveAt > best ? v.effectiveAt : best),
    null
  );

  // enforcedVersion: mayor versión vigente con requiresReacceptance (candidato a elevar el umbral).
  const reaccep = inForce.filter((v) => v.requiresReacceptance);
  const candidate = reaccep.reduce<(typeof versions)[number] | null>(
    (best, v) => (!best || v.version > best.version ? v : best),
    null
  );

  const state: DenormState = {
    currentVersionId: current?._id ?? null,
    currentVersionNumber: current?.version ?? 0,
    currentContentHash: current?.contentHash ?? '',
    currentEffectiveAt: current?.effectiveAt ?? null,
    currentExpiresAt: current?.expiresAt ?? null,
    nextVersionId: next?._id ?? null,
    nextVersionNumber: next?.version ?? 0,
    nextEffectiveAt: next?.effectiveAt ?? null,
    nextContentHash: next?.contentHash ?? '',
    nextRequiresReacceptance: next?.requiresReacceptance ?? false,
  };

  const maxVersionSeen = latest?.version ?? 0;

  if (authoritative) {
    // RECONCILER de boot (single-thread): resetea los watermarks al valor REAL entre versiones
    // PUBLICADAS — sana cualquier "fantasma" que un crash entre el watermark CAS y el status-flip de
    // publishVersion haya dejado adelantado (B-reaudit HIGH-3/B-3). Así un draft huérfano puede
    // re-publicarse sin quedar bloqueado por un watermark inflado. Fuera de boot NO se hace: los
    // watermarks son raise-only en el hot-path (un recompute stale jamás los baja).
    await ComplianceDocument.updateOne(
      { _id: docObjId },
      {
        $set: {
          ...state,
          latestPublishedVersion: maxVersionSeen,
          latestPublishedEffectiveAt: maxEffectiveAt ?? null,
          denormComputedAt: at,
          denormReflectedVersion: maxVersionSeen,
        },
      }
    );
  } else {
    // Watermarks monotónicos PRIMERO (antes del $set de current*): se elevan con guard `$lt` para que un
    // recompute concurrente (que leyó antes del status-flip de un publish) NO los baje. El watermark es
    // el invariante de monotonicidad que usa publishVersion (B P1b HIGH-1).
    if (latest) {
      await ComplianceDocument.updateOne(
        { _id: docObjId, latestPublishedVersion: { $lt: latest.version } },
        { $set: { latestPublishedVersion: latest.version } }
      );
    }
    if (maxEffectiveAt) {
      await ComplianceDocument.updateOne(
        {
          _id: docObjId,
          $or: [
            { latestPublishedEffectiveAt: null },
            { latestPublishedEffectiveAt: { $lt: maxEffectiveAt } },
          ],
        },
        { $set: { latestPublishedEffectiveAt: maxEffectiveAt } }
      );
    }
    // $set de current/next CONDICIONADO por DOS watermarks, para que ningún recompute STALE pise el
    // current de uno más nuevo (B-reaudit HIGH-2 + verify MED):
    //  (1) de PUBLICACIÓN: `latestPublishedVersion <= maxVersionSeen` → descarta al que vio MENOS
    //      versiones publicadas (carrera con un publish).
    //  (2) TEMPORAL: `denormComputedAt <= at` → descarta al que computó con un `now()` ANTERIOR (uno que
    //      cruzó el effectiveAt de una versión programada y reanudó tarde escribía un current viejo
    //      aunque hubiera el MISMO conjunto de versiones publicadas).
    // Determinista para un mismo snapshot → recomputes con la misma vista convergen; el guard sólo
    // descarta al que quedó atrás. Permite limpiar current expirado (current→0) sin nuevas versiones.
    await ComplianceDocument.updateOne(
      {
        _id: docObjId,
        $and: [
          {
            $or: [
              { latestPublishedVersion: null },
              { latestPublishedVersion: { $exists: false } },
              { latestPublishedVersion: { $lte: maxVersionSeen } },
            ],
          },
          {
            $or: [
              { denormComputedAt: null },
              { denormComputedAt: { $exists: false } },
              { denormComputedAt: { $lte: at } },
            ],
          },
        ],
      },
      { $set: { ...state, denormComputedAt: at, denormReflectedVersion: maxVersionSeen } }
    );
  }

  // enforcedVersion se eleva ATÓMICAMENTE y SÓLO sube (guard `$lt` o inexistente/null/0): un recompute
  // concurrente jamás pisa el umbral que fijó updateDocumentMetadata(block_*) ni lo baja a 0 (D-032).
  // `$in: [0, null]` cubre documentos preexistentes donde lean() devuelve `undefined` porque el campo
  // aún no existía (misma familia de bypass que denormReflectedVersion, B-reaudit verify HIGH).
  if (candidate) {
    await ComplianceDocument.updateOne(
      {
        _id: docObjId,
        $or: [
          { enforcedVersion: { $lt: candidate.version } },
          { enforcedVersion: { $in: [0, null] } },
        ],
      },
      { $set: { enforcedVersion: candidate.version, enforcedFrom: candidate.effectiveAt } }
    );
  } else if (current) {
    // BOOTSTRAP (B-reaudit verify HIGH): un documento `block_*` con una versión vigente DEBE exigir al
    // menos la ACEPTACIÓN INICIAL de la current, aunque ninguna versión pida reaceptación
    // (`requiresReacceptance` gobierna la RE-aceptación de versiones siguientes, no la primera). Sin esto,
    // crear el doc directamente como `block_full` (API/automatización) y publicar una v1 con
    // `requiresReacceptance:false` dejaba `enforcedVersion=0` → `blocking=false` → el gate NO bloqueaba.
    // Sólo se eleva cuando enforcedVersion sigue en 0 o null (guard atómico) → no fuerza reaceptación en
    // versiones non-reaccep posteriores ni baja un umbral ya fijado por updateDocumentMetadata.
    // `$in: [0, null]` cubre documentos preexistentes donde lean() devuelve `undefined` porque el campo
    // aún no existía (misma familia de bypass que denormReflectedVersion, B-reaudit verify HIGH).
    await ComplianceDocument.updateOne(
      {
        _id: docObjId,
        enforcement: { $in: ['block_full', 'block_partial'] },
        enforcedVersion: { $in: [0, null] },
      },
      { $set: { enforcedVersion: current.version, enforcedFrom: current.effectiveAt } }
    );
  }
}

/** Reconciler de boot (patrón reconcile-indexes): recomputa la denorm de todos los documentos. */
export async function reconcileComplianceDenorm(): Promise<number> {
  const docs = await ComplianceDocument.find({}).select('_id').lean();
  for (const d of docs) {
    await recomputeDenorm(d._id, { authoritative: true });
  }
  return docs.length;
}

/** Si la próxima versión programada ya entró en vigencia, promuévela (lazy, fuera del hot path). */
async function maybePromote(
  doc: Pick<IComplianceDocument, '_id' | 'nextEffectiveAt'>
): Promise<boolean> {
  if (doc.nextEffectiveAt && doc.nextEffectiveAt <= now()) {
    await recomputeDenorm(doc._id);
    return true;
  }
  return false;
}

// ───────────────────────── Auditoría de acciones admin ─────────────────────────

export async function logAdminAction(input: {
  tenantId: string;
  actorId?: mongoose.Types.ObjectId | null;
  actorEmail?: string;
  action: ComplianceAdminActionType;
  targetType?: string;
  targetId?: mongoose.Types.ObjectId | null;
  documentKey?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}): Promise<void> {
  await ComplianceAdminAction.create({
    tenantId: input.tenantId,
    actorId: input.actorId ?? null,
    actorEmail: input.actorEmail ?? '',
    action: input.action,
    targetType: input.targetType ?? '',
    targetId: input.targetId ?? null,
    documentKey: input.documentKey ?? '',
    before: input.before,
    after: input.after,
    ip: input.ip ?? '',
    at: now(),
  });
}

// ───────────────────────── Documentos: CRUD de metadata ─────────────────────────

export async function createDocument(input: {
  tenantId: string;
  key: string;
  category: IComplianceDocument['category'];
  title: string;
  enforcement?: ComplianceEnforcement;
  audience?: IComplianceDocument['audience'];
  order?: number;
  defaultLocale?: string;
  system?: boolean;
  actor?: { id?: mongoose.Types.ObjectId | null; email?: string; ip?: string };
}): Promise<IComplianceDocument> {
  const existing = await ComplianceDocument.findOne({
    tenantId: input.tenantId,
    key: input.key,
  }).lean();
  if (existing)
    throw new ComplianceError('Ya existe un documento con esa clave', 409, 'DUPLICATE_KEY');
  const doc = await ComplianceDocument.create({
    tenantId: input.tenantId,
    key: input.key,
    category: input.category,
    title: input.title,
    enforcement: input.enforcement ?? 'soft',
    audience: input.audience ?? 'all',
    order: input.order ?? 0,
    defaultLocale: input.defaultLocale ?? 'es',
    system: input.system ?? false,
  });
  await bumpEpoch(input.tenantId);
  await logAdminAction({
    tenantId: input.tenantId,
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email,
    action: 'create_document',
    targetType: 'document',
    targetId: doc._id,
    documentKey: doc.key,
    after: { key: doc.key, enforcement: doc.enforcement },
    ip: input.actor?.ip,
  });
  return doc;
}

/**
 * Actualiza metadata del documento. Al fijar `enforcement` a `block_*` (C-M4/D-027): exige una
 * versión vigente publicada y, si `enforcedVersion` es 0/inexistente, lo eleva a `currentVersionNumber`
 * — si no, el gate nunca bloquearía. Bump epoch + auditoría.
 */
export async function updateDocumentMetadata(
  tenantId: string,
  documentId: mongoose.Types.ObjectId | string,
  patch: {
    title?: string;
    enforcement?: ComplianceEnforcement;
    audience?: IComplianceDocument['audience'];
    active?: boolean;
    order?: number;
  },
  actor?: { id?: mongoose.Types.ObjectId | null; email?: string; ip?: string }
): Promise<IComplianceDocument> {
  const doc = await ComplianceDocument.findOne({ _id: documentId, tenantId });
  if (!doc || doc.deletedAt != null)
    throw new ComplianceError('Documento no encontrado', 404, 'DOC_NOT_FOUND');
  const before = { enforcement: doc.enforcement, active: doc.active, audience: doc.audience };
  if (patch.title !== undefined) doc.title = patch.title;
  if (patch.audience !== undefined) doc.audience = patch.audience;
  if (patch.active !== undefined) doc.active = patch.active;
  if (patch.order !== undefined) doc.order = patch.order;
  let raiseEnforced: { version: number; from: Date } | null = null;
  if (patch.enforcement !== undefined) {
    doc.enforcement = patch.enforcement;
    if (patch.enforcement === 'block_partial' || patch.enforcement === 'block_full') {
      if (doc.currentVersionNumber === 0 || doc.currentVersionId == null) {
        throw new ComplianceError(
          'No se puede exigir un documento sin una versión vigente publicada',
          409,
          'NO_PUBLISHED_VERSION'
        );
      }
      raiseEnforced = { version: doc.currentVersionNumber, from: doc.currentEffectiveAt ?? now() };
    }
  }
  // Persiste la metadata (title/audience/active/order/enforcement). NUNCA se modifica `enforcedVersion` en
  // el objeto Mongoose → `doc.save()` NO puede re-persistir un umbral REBAJADO bajo ningún orden de
  // escritura (B-reaudit v3 HIGH: el downgrade venía de reflejar el raise en el objeto y re-guardarlo
  // cuando un publish concurrente ya lo había subido más alto). Order-INDEPENDIENTE por construcción.
  await doc.save();
  // enforcedVersion se eleva en un updateOne SEPARADO y MONÓTONO (sólo sube): si un publish/recompute
  // concurrente ya lo subió por encima de `raiseEnforced.version`, el guard no matchea y NO lo baja. El
  // `$in:[0,null]` cubre el bootstrap desde 0/inexistente (doc legacy). Crash-safety: si el proceso cae
  // entre el save() y este raise, el doc queda block_* con enforcedVersion=0 → getPendingForUser lo
  // AUTO-SANA (invariante c). (D-032/D-027)
  if (raiseEnforced) {
    await ComplianceDocument.updateOne(
      {
        _id: doc._id,
        $or: [
          { enforcedVersion: { $lt: raiseEnforced.version } },
          { enforcedVersion: { $in: [0, null] } },
        ],
      },
      { $set: { enforcedVersion: raiseEnforced.version, enforcedFrom: raiseEnforced.from } }
    );
  }
  await bumpEpoch(doc.tenantId);
  await logAdminAction({
    tenantId: doc.tenantId,
    actorId: actor?.id ?? null,
    actorEmail: actor?.email,
    action: 'update_document',
    targetType: 'document',
    targetId: doc._id,
    documentKey: doc.key,
    before,
    after: { enforcement: doc.enforcement, active: doc.active, audience: doc.audience },
    ip: actor?.ip,
  });
  // Relee para devolver el estado FRESCO: el raise fue un updateOne directo (no reflejado en `doc`) y un
  // publish concurrente pudo elevar enforcedVersion aún más. Nunca devolvemos/re-persistimos un umbral rebajado.
  return (await ComplianceDocument.findOne({ _id: doc._id, tenantId })) ?? doc;
}

/**
 * Borra un documento. Hard-delete SÓLO si no es system y no tiene versiones publicadas ni
 * aceptaciones (B-M4); en cualquier otro caso, soft-delete (`deletedAt`).
 */
export async function deleteDocument(
  tenantId: string,
  documentId: mongoose.Types.ObjectId | string,
  actor?: { id?: mongoose.Types.ObjectId | null; email?: string; ip?: string }
): Promise<{ hardDeleted: boolean }> {
  const doc = await ComplianceDocument.findOne({ _id: documentId, tenantId });
  if (!doc || doc.deletedAt != null)
    throw new ComplianceError('Documento no encontrado', 404, 'DOC_NOT_FOUND');
  const hasPublished = await ComplianceVersion.exists({ documentId: doc._id, status: 'published' });
  const hasAcceptance = await ComplianceAcceptance.exists({ documentId: doc._id });
  const canHardDelete = !doc.system && !hasPublished && !hasAcceptance;
  if (canHardDelete) {
    await ComplianceVersion.deleteMany({ documentId: doc._id, status: 'draft' });
    await ComplianceDocument.deleteOne({ _id: doc._id });
  } else {
    doc.deletedAt = now();
    doc.active = false;
    await doc.save();
  }
  await bumpEpoch(doc.tenantId);
  await logAdminAction({
    tenantId: doc.tenantId,
    actorId: actor?.id ?? null,
    actorEmail: actor?.email,
    action: 'delete_document',
    targetType: 'document',
    targetId: doc._id,
    documentKey: doc.key,
    after: { hardDeleted: canHardDelete },
    ip: actor?.ip,
  });
  return { hardDeleted: canHardDelete };
}

// ───────────────────────── Versiones: draft, publish ─────────────────────────

interface DraftContentInput {
  locale: string;
  title: string;
  bodyMarkdown: string;
}

function renderContents(contents: DraftContentInput[]): {
  rendered: IComplianceLocaleContent[];
  contentHash: string;
  pipelineVersion: string;
} {
  let pipelineVersion = '';
  const rendered = contents.map((c) => {
    const { html, pipelineVersion: pv } = renderComplianceMarkdown(c.bodyMarkdown);
    pipelineVersion = pv;
    return { locale: c.locale, title: c.title, bodyMarkdown: c.bodyMarkdown, bodyHtml: html };
  });
  const contentHash = computeContentHash(contents);
  return { rendered, contentHash, pipelineVersion };
}

/**
 * Crea una versión DRAFT. El número de versión se asigna AQUÍ vía `$inc versionCounter` atómico
 * (evita placeholders colisionando en el índice único); publicar sólo transiciona el estado. Los gaps
 * de secuencia por drafts descartados son inocuos (DESIGN §4.3).
 */
export async function createDraftVersion(input: {
  tenantId: string;
  documentId: mongoose.Types.ObjectId | string;
  contents: DraftContentInput[];
  changeSummary?: string;
  requiresReacceptance?: boolean;
  effectiveAt: Date;
  expiresAt?: Date | null;
  authorId?: mongoose.Types.ObjectId | null;
  authorEmail?: string;
}): Promise<IComplianceVersion> {
  if (input.contents.length === 0) {
    throw new ComplianceError(
      'Una versión requiere al menos un contenido localizado',
      400,
      'NO_CONTENT'
    );
  }
  if (input.expiresAt && input.expiresAt <= input.effectiveAt) {
    throw new ComplianceError(
      'expiresAt debe ser posterior a effectiveAt',
      400,
      'BAD_VALIDITY_WINDOW'
    );
  }
  const docObjId =
    typeof input.documentId === 'string'
      ? new mongoose.Types.ObjectId(input.documentId)
      : input.documentId;
  const doc = await ComplianceDocument.findOneAndUpdate(
    { _id: docObjId, tenantId: input.tenantId, deletedAt: null }, // no crear versiones sobre doc borrado (D-006)
    { $inc: { versionCounter: 1 } },
    { new: true }
  );
  if (!doc) throw new ComplianceError('Documento no encontrado', 404, 'DOC_NOT_FOUND');
  const { rendered, contentHash, pipelineVersion } = renderContents(input.contents);
  return ComplianceVersion.create({
    tenantId: input.tenantId,
    documentId: docObjId,
    documentKey: doc.key,
    version: doc.versionCounter,
    status: 'draft',
    contents: rendered,
    pipelineVersion,
    contentHash,
    changeSummary: input.changeSummary ?? '',
    requiresReacceptance: input.requiresReacceptance ?? true,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt ?? null,
    authorId: input.authorId ?? null,
    authorEmail: input.authorEmail ?? '',
  });
}

/** Edita una versión DRAFT (re-renderiza HTML y recomputa contentHash). Published → 409. */
export async function updateDraftVersion(
  tenantId: string,
  versionId: mongoose.Types.ObjectId | string,
  patch: {
    contents?: DraftContentInput[];
    changeSummary?: string;
    requiresReacceptance?: boolean;
    effectiveAt?: Date;
    expiresAt?: Date | null;
  }
): Promise<IComplianceVersion> {
  const v = await ComplianceVersion.findOne({ _id: versionId, tenantId });
  if (!v) throw new ComplianceError('Versión no encontrada', 404, 'VERSION_NOT_FOUND');
  if (v.status !== 'draft') {
    throw new ComplianceError('Sólo se editan borradores', 409, 'NOT_DRAFT');
  }
  if (patch.contents) {
    const { rendered, contentHash, pipelineVersion } = renderContents(patch.contents);
    v.contents = rendered;
    v.contentHash = contentHash;
    v.pipelineVersion = pipelineVersion;
  }
  if (patch.changeSummary !== undefined) v.changeSummary = patch.changeSummary;
  if (patch.requiresReacceptance !== undefined) v.requiresReacceptance = patch.requiresReacceptance;
  if (patch.effectiveAt !== undefined) v.effectiveAt = patch.effectiveAt;
  if (patch.expiresAt !== undefined) v.expiresAt = patch.expiresAt;
  if (v.expiresAt && v.expiresAt <= v.effectiveAt) {
    throw new ComplianceError(
      'expiresAt debe ser posterior a effectiveAt',
      400,
      'BAD_VALIDITY_WINDOW'
    );
  }
  await v.save();
  return v;
}

/**
 * Publica una versión draft (DESIGN §4.3, standalone-safe). Invariante de `effectiveAt` monótono
 * (B-v3 HIGH): rechaza si effectiveAt < latestPublishedEffectiveAt. Transición draft→published vía
 * save() (permitida por el middleware), luego recomputeDenorm + bump epoch.
 */
export async function publishVersion(
  tenantId: string,
  versionId: mongoose.Types.ObjectId | string,
  actor?: { id?: mongoose.Types.ObjectId | null; email?: string; ip?: string }
): Promise<IComplianceVersion> {
  const v = await ComplianceVersion.findOne({ _id: versionId, tenantId });
  if (!v) throw new ComplianceError('Versión no encontrada', 404, 'VERSION_NOT_FOUND');
  if (v.status !== 'draft') {
    throw new ComplianceError('La versión no es un borrador', 409, 'NOT_DRAFT');
  }
  // Watermark monótono ATÓMICO (B P1b HIGH-1): avanza `latestPublishedEffectiveAt` del documento
  // SÓLO si `v.effectiveAt >= el actual`. Cierra la carrera de DOS DRAFTS DISTINTOS publicándose en
  // paralelo con effectiveAt desordenado: el CAS serializa el invariante a nivel de documento (no un
  // pre-check leído-y-luego-escrito). El de menor effectiveAt que llegue después es rechazado.
  //
  // ADEMÁS, ordinal de versión monótono (B-reaudit HIGH-1): el número de versión publicado debe SUPERAR
  // al último publicado. `version` se asigna al crear el draft (orden de creación), pero `current` se
  // elige por mayor `effectiveAt` y `enforcedVersion` por mayor número de versión; si esos dos órdenes
  // discrepan (publicar un draft de menor número con effectiveAt posterior), enforcedVersion podía
  // superar a currentVersionNumber → threshold insatisfacible (un usuario nuevo sólo puede aceptar la
  // current). Exigir y avanzar `latestPublishedVersion` en el MISMO CAS mantiene ambos órdenes alineados:
  // la versión publicada más reciente es a la vez la de mayor número y la de mayor effectiveAt → se
  // garantiza enforcedVersion ≤ currentVersionNumber. El avance es atómico para que dos publishes
  // concurrentes desordenados no pasen ambos.
  const claimed = await ComplianceDocument.findOneAndUpdate(
    {
      _id: v.documentId,
      deletedAt: null,
      $and: [
        {
          $or: [
            { latestPublishedEffectiveAt: null },
            { latestPublishedEffectiveAt: { $lte: v.effectiveAt } },
          ],
        },
        {
          $or: [
            { latestPublishedVersion: null },
            { latestPublishedVersion: { $exists: false } },
            { latestPublishedVersion: { $lt: v.version } },
          ],
        },
      ],
    },
    { $set: { latestPublishedEffectiveAt: v.effectiveAt, latestPublishedVersion: v.version } },
    { new: true }
  );
  if (!claimed) {
    const exists = await ComplianceDocument.exists({ _id: v.documentId, deletedAt: null });
    if (!exists) throw new ComplianceError('Documento no encontrado', 404, 'DOC_NOT_FOUND');
    throw new ComplianceError(
      'La publicación rompe el orden monótono: effectiveAt y número de versión deben ser ≥ a la última versión publicada',
      409,
      'EFFECTIVE_AT_NOT_MONOTONIC'
    );
  }
  // Transición ATÓMICA draft→published (CAS): de dos publish concurrentes de la MISMA versión, sólo
  // uno matchea status:'draft'. El middleware acota a draft → consistente.
  const published = await ComplianceVersion.findOneAndUpdate(
    { _id: v._id, status: 'draft' },
    { $set: { status: 'published', publishedAt: now() } },
    { new: true }
  );
  if (!published) {
    throw new ComplianceError('La versión ya no es un borrador', 409, 'NOT_DRAFT');
  }
  await recomputeDenorm(published.documentId);
  await bumpEpoch(published.tenantId);
  counters.compliancePublishes++;
  await logAdminAction({
    tenantId: published.tenantId,
    actorId: actor?.id ?? null,
    actorEmail: actor?.email,
    action: 'publish',
    targetType: 'version',
    targetId: published._id,
    documentKey: published.documentKey,
    after: {
      version: published.version,
      requiresReacceptance: published.requiresReacceptance,
      effectiveAt: published.effectiveAt,
    },
    ip: actor?.ip,
  });
  return published;
}

// ───────────────────────── Gating ─────────────────────────

function audienceApplies(audience: string, role: 'user' | 'admin'): boolean {
  return audience === 'all' || audience === `role:${role}`;
}

const ENFORCEMENT_RANK: Record<ComplianceEnforcement, number> = {
  none: 0,
  soft: 1,
  block_partial: 2,
  block_full: 3,
};

export interface PendingDocument {
  key: string;
  title: string;
  version: number;
  enforcement: ComplianceEnforcement;
  blocking: boolean;
}

export interface PendingResult {
  enforcement: ComplianceEnforcement; // modo efectivo de la sesión (el más estricto bloqueante)
  documents: PendingDocument[];
  // Próximo instante en que el estado de compliance del usuario PODRÍA cambiar adversamente sin un
  // publish (una versión programada entra en vigencia / un enforcedFrom futuro). El gate acota el TTL de
  // su caché "usuario conforme" a este instante para no dejar pasar hasta 60s una política recién vigente
  // (B-reaudit MED-5). `null` = sin eventos temporales futuros conocidos.
  recheckAt?: Date | null;
}

/**
 * Calcula los documentos pendientes de un usuario (DESIGN §3.1). Lee SÓLO `ComplianceDocument`
 * (denormalizado) + un lookup indexado de aceptaciones. Promueve `next→current` de forma lazy si
 * una versión programada ya entró en vigencia (off hot-path, raro).
 */
export async function getPendingForUser(
  tenantId: string,
  user: { id: mongoose.Types.ObjectId | string; role: 'user' | 'admin' }
): Promise<PendingResult> {
  if (isEnforcementDisabled()) return { enforcement: 'none', documents: [] };
  const at = now();
  let docs = await ComplianceDocument.find({
    tenantId,
    active: true,
    deletedAt: null,
    enforcement: { $ne: 'none' },
  }).lean();

  // Recompute lazy + auto-sanación de denorm inconsistente. Recomputa si:
  //  (a) una versión programada ya entró en vigencia (promoción next→current), o el current ya expiró;
  //  (b) la denorm quedó STALE — `latestPublishedVersion > denormReflectedVersion`: se publicó una versión
  //      que el recompute aún NO reflejó (crash entre el status-flip de publishVersion y su recompute).
  //      `denormReflectedVersion` se eleva sólo cuando el recompute escribe el denorm, así que distingue
  //      ese crash de un doc cuya versión vigente ya expiró (ahí reflected == latest → no recomputa en
  //      bucle). Cubre el bypass de PRIMERA publicación (currentVersionNumber=0).
  //  (c) INVARIANTE de exigibilidad roto — un doc `block_*` con una versión vigente pero `enforcedVersion=0`
  //      (o inexistente: lean() devuelve `undefined` para documentos preexistentes sin el campo). Cierra
  //      la ventana de escritura en DOS pasos de recomputeDenorm (escribió current* pero crasheó antes de
  //      elevar enforcedVersion) y sanea datos legados; updateDocumentMetadata ahora eleva enforcedVersion
  //      ANTES de doc.save(), así que nunca deja block_* sin umbral por un crash en ese path.
  // `?? 0` defensivo: `.lean()` NO aplica el default del schema a documentos PREEXISTENTES sin el campo →
  // sin esto `n > undefined` es `false` y el bypass persistiría en datos previos (B + D verify).
  const needsRecompute = docs.filter(
    (d) =>
      (d.nextEffectiveAt != null && d.nextEffectiveAt <= at) ||
      (d.currentExpiresAt != null && d.currentExpiresAt <= at) ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- lean() no aplica defaults
      d.latestPublishedVersion > (d.denormReflectedVersion ?? 0) ||
      ((d.enforcement === 'block_full' || d.enforcement === 'block_partial') &&
        d.currentVersionNumber > 0 &&
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- lean() no aplica defaults
        (d.enforcedVersion ?? 0) === 0)
  );
  if (needsRecompute.length > 0) {
    for (const d of needsRecompute) await recomputeDenorm(d._id);
    docs = await ComplianceDocument.find({
      tenantId,
      active: true,
      deletedAt: null,
      enforcement: { $ne: 'none' },
    }).lean();
  }

  // recheckAt: el evento temporal futuro MÁS PRÓXIMO entre los docs enforced de la audiencia del usuario
  // (una versión programada que entra en vigencia, un current futuro, o un enforcedFrom futuro). Se
  // computa sobre TODOS los docs (no sólo los aplicables ahora) para cubrir un block_full cuya primera
  // versión es futura. El gate usa esto para acotar el TTL de su caché de usuario (B-reaudit MED-5).
  let recheckAt: Date | null = null;
  for (const d of docs) {
    if (!audienceApplies(d.audience, user.role)) continue;
    for (const cand of [d.nextEffectiveAt, d.currentEffectiveAt, d.enforcedFrom]) {
      if (cand != null && cand > at && (recheckAt == null || cand < recheckAt)) recheckAt = cand;
    }
  }

  // Aplicables al rol, con versión vigente.
  const applicable = docs.filter(
    (d) =>
      audienceApplies(d.audience, user.role) &&
      d.currentVersionId != null &&
      d.currentEffectiveAt != null &&
      d.currentEffectiveAt <= at &&
      (d.currentExpiresAt == null || d.currentExpiresAt > at)
  );
  if (applicable.length === 0) return { enforcement: 'none', documents: [], recheckAt };

  // Lookup de la versión máxima aceptada por el usuario, por documentKey.
  const keys = applicable.map((d) => d.key);
  const accepts = await ComplianceAcceptance.find({
    tenantId,
    userId: user.id,
    documentKey: { $in: keys },
  })
    .select('documentKey version')
    .lean();
  const maxAccepted = new Map<string, number>();
  for (const a of accepts) {
    maxAccepted.set(a.documentKey, Math.max(maxAccepted.get(a.documentKey) ?? 0, a.version));
  }

  const pending: PendingDocument[] = [];
  let effectiveRank = 0;
  for (const d of applicable) {
    const blockingThreshold =
      d.enforcedVersion > 0 && (d.enforcedFrom == null || d.enforcedFrom <= at);
    // El threshold NUNCA excede currentVersionNumber (B-reaudit HIGH-1, cinturón): la ÚNICA versión que
    // `/accept` admite es la current, así que exigir más sería insatisfacible. El fix de publishVersion
    // garantiza enforcedVersion ≤ currentVersionNumber; este `min` además sanea datos legados.
    const threshold = Math.min(
      blockingThreshold ? d.enforcedVersion : d.currentVersionNumber,
      d.currentVersionNumber
    );
    const accepted = maxAccepted.get(d.key) ?? 0;
    if (accepted >= threshold) continue; // ya cumplido
    const blocking =
      blockingThreshold && (d.enforcement === 'block_full' || d.enforcement === 'block_partial');
    pending.push({
      key: d.key,
      title: d.title,
      version: d.currentVersionNumber,
      enforcement: d.enforcement,
      blocking,
    });
    if (blocking) effectiveRank = Math.max(effectiveRank, ENFORCEMENT_RANK[d.enforcement]);
  }

  const effectiveEntry = (
    Object.entries(ENFORCEMENT_RANK) as [ComplianceEnforcement, number][]
  ).find(([, r]) => r === effectiveRank);
  return {
    enforcement: effectiveEntry ? effectiveEntry[0] : 'none',
    documents: pending,
    recheckAt,
  };
}

// ───────────────────────── Aceptación + evidencia ─────────────────────────

export async function recordAcceptance(input: {
  tenantId: string;
  user: { id: mongoose.Types.ObjectId | string; email: string; role: 'user' | 'admin' };
  documentKey: string;
  version: number;
  ip: string;
  userAgent: string;
  locale: string;
  method?: 'explicit_click' | 'scroll_confirmed';
}): Promise<{ accepted: boolean }> {
  const at = now();
  let doc = await ComplianceDocument.findOne({
    tenantId: input.tenantId,
    key: input.documentKey,
    deletedAt: null,
  });
  if (!doc) throw new ComplianceError('Documento no encontrado', 404, 'DOC_NOT_FOUND');
  // Sólo se acepta un documento APLICABLE al usuario: activo, enforced y de su audiencia. Si no aplica,
  // 404 (no se distingue "no existe" de "no es para ti") — evita aceptar docs inactivos/admin-only (B P2 MED-1).
  if (
    !doc.active ||
    doc.enforcement === 'none' ||
    !audienceApplies(doc.audience, input.user.role)
  ) {
    throw new ComplianceError('Documento no encontrado', 404, 'DOC_NOT_FOUND');
  }
  // Promueve la versión vigente si una programada ya entró en vigencia (evita rechazar una aceptación válida).
  if (await maybePromote(doc)) {
    doc = await ComplianceDocument.findOne({ _id: doc._id, tenantId: input.tenantId });
    if (!doc) throw new ComplianceError('Documento no encontrado', 404, 'DOC_NOT_FOUND');
  }
  // La versión enviada debe ser la VIGENTE (publicada, en ventana de vigencia) — no expirada ni futura.
  const inForce =
    doc.currentVersionId != null &&
    doc.currentEffectiveAt != null &&
    doc.currentEffectiveAt <= at &&
    (doc.currentExpiresAt == null || doc.currentExpiresAt > at);
  if (!inForce || doc.currentVersionNumber !== input.version) {
    throw new ComplianceError(
      'La versión enviada no es la vigente; recargue el documento',
      409,
      'VERSION_STALE'
    );
  }
  const fields: EvidenceFields = {
    tenantId: input.tenantId,
    userId: String(input.user.id),
    documentKey: input.documentKey,
    versionId: String(doc.currentVersionId),
    version: input.version,
    contentHash: doc.currentContentHash,
    acceptedAt: at.toISOString(),
    ip: input.ip,
    userAgent: input.userAgent,
    method: input.method ?? 'explicit_click',
    locale: input.locale,
  };
  const { hmacKeyId, evidenceHmac } = signEvidence(fields);
  try {
    await ComplianceAcceptance.create({
      tenantId: input.tenantId,
      userId: input.user.id,
      userEmail: input.user.email,
      documentId: doc._id,
      documentKey: input.documentKey,
      versionId: doc.currentVersionId,
      version: input.version,
      contentHash: doc.currentContentHash,
      acceptedAt: at,
      ip: input.ip,
      userAgent: input.userAgent,
      locale: input.locale,
      method: input.method ?? 'explicit_click',
      hmacKeyId,
      evidenceHmac,
    });
    counters.complianceAcceptances++;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      return { accepted: true }; // E11000 → ya aceptada (idempotente)
    }
    throw err;
  }
  return { accepted: true };
}

/** Verifica el HMAC de una aceptación (tamper-evidence demostrable, C-M9). */
export async function verifyAcceptanceById(
  tenantId: string,
  id: mongoose.Types.ObjectId | string
): Promise<{ valid: boolean; reason?: string }> {
  const a = await ComplianceAcceptance.findOne({ _id: id, tenantId }).lean();
  if (!a) return { valid: false, reason: 'not_found' };
  const fields: EvidenceFields = {
    tenantId: a.tenantId,
    userId: String(a.userId),
    documentKey: a.documentKey,
    versionId: String(a.versionId),
    version: a.version,
    contentHash: a.contentHash,
    acceptedAt: a.acceptedAt.toISOString(),
    ip: a.ip,
    userAgent: a.userAgent,
    method: a.method,
    locale: a.locale,
  };
  return { valid: verifyEvidence(fields, a.hmacKeyId, a.evidenceHmac) };
}
