import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { ComplianceDocument } from '../../models/ComplianceDocument.js';
import { ComplianceVersion } from '../../models/ComplianceVersion.js';
import { ComplianceAcceptance } from '../../models/ComplianceAcceptance.js';
import { ComplianceSettings } from '../../models/ComplianceSettings.js';
import {
  createDraftVersion,
  publishVersion,
  getPendingForUser,
  recordAcceptance,
  verifyAcceptanceById,
  updateDocumentMetadata,
  recomputeDenorm,
  reconcileComplianceDenorm,
} from '../compliance.js';

const PAST = new Date('2020-01-01T00:00:00Z');
const PAST2 = new Date('2021-01-01T00:00:00Z');
const FUTURE = new Date('2099-01-01T00:00:00Z');
const FUTURE_MID = new Date('2050-01-01T00:00:00Z');
const T = 'default';

async function makeDoc(enforcement = 'block_full' as const, audience = 'all' as const) {
  return ComplianceDocument.create({
    tenantId: T,
    key: 'terms-of-service',
    category: 'legal',
    title: 'Términos',
    enforcement,
    audience,
  });
}

const content = [{ locale: 'es', title: 'T', bodyMarkdown: '# Hola\n\nTexto.' }];

describe('compliance service', () => {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
  beforeEach(async () => {
    for (const m of [
      ComplianceDocument,
      ComplianceVersion,
      ComplianceAcceptance,
      ComplianceSettings,
    ]) {
      await mongoose.connection.db!.collection(m.collection.name).deleteMany({});
    }
  });

  it('publish vigente: setea denorm current y renderiza bodyHtml + contentHash', async () => {
    const doc = await makeDoc();
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: true,
    });
    expect(v.version).toBe(1);
    expect(v.contents[0].bodyHtml).toContain('<h1>Hola</h1>');
    expect(v.contentHash).toMatch(/^[a-f0-9]{64}$/);

    await publishVersion(T, v._id);
    const after = await ComplianceDocument.findById(doc._id).lean();
    expect(after!.currentVersionNumber).toBe(1);
    expect(after!.latestPublishedVersion).toBe(1);
    expect(after!.enforcedVersion).toBe(1); // requiresReacceptance → enforced
    expect(after!.enforcedFrom).toEqual(PAST);
  });

  it('publish con effectiveAt no monótono → 409', async () => {
    const doc = await makeDoc();
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST2,
    });
    await publishVersion(T, v1._id);
    const v2 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await expect(publishVersion(T, v2._id)).rejects.toMatchObject({
      code: 'EFFECTIVE_AT_NOT_MONOTONIC',
    });
  });

  it('versión con effectiveAt futuro: va al slot next*, current no cambia', async () => {
    const doc = await makeDoc();
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await publishVersion(T, v1._id);
    const v2 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: FUTURE,
    });
    await publishVersion(T, v2._id);
    const after = await ComplianceDocument.findById(doc._id).lean();
    expect(after!.currentVersionNumber).toBe(1); // sigue v1
    expect(after!.nextVersionNumber).toBe(2);
    expect(after!.nextEffectiveAt).toEqual(FUTURE);
    expect(after!.latestPublishedVersion).toBe(2);
  });

  it('recomputeDenorm promueve next→current cuando effectiveAt ya pasó', async () => {
    const doc = await makeDoc();
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await publishVersion(T, v1._id);
    const v2 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST2,
      requiresReacceptance: true,
    });
    await publishVersion(T, v2._id);
    // PAST2 ya pasó → v2 debe ser current y enforced.
    const after = await ComplianceDocument.findById(doc._id).lean();
    expect(after!.currentVersionNumber).toBe(2);
    expect(after!.enforcedVersion).toBe(2);
    expect(after!.nextVersionNumber).toBe(0);
  });

  it('gating: block_full no aceptado → pending blocking; tras aceptar → vacío', async () => {
    const doc = await makeDoc();
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: true,
    });
    await publishVersion(T, v._id);
    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };

    const before = await getPendingForUser(T, user);
    expect(before.enforcement).toBe('block_full');
    expect(before.documents).toHaveLength(1);
    expect(before.documents[0].blocking).toBe(true);

    await recordAcceptance({
      tenantId: T,
      user,
      documentKey: 'terms-of-service',
      version: 1,
      ip: '1.2.3.4',
      userAgent: 'UA',
      locale: 'es',
    });
    const after = await getPendingForUser(T, user);
    expect(after.enforcement).toBe('none');
    expect(after.documents).toHaveLength(0);
  });

  it('accept idempotente: doble aceptación no duplica ni falla', async () => {
    const doc = await makeDoc();
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await publishVersion(T, v._id);
    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    const args = {
      tenantId: T,
      user,
      documentKey: 'terms-of-service',
      version: 1,
      ip: 'i',
      userAgent: 'u',
      locale: 'es',
    };
    await recordAcceptance(args);
    await expect(recordAcceptance(args)).resolves.toEqual({ accepted: true });
    expect(await ComplianceAcceptance.countDocuments({ userId: user.id })).toBe(1);
  });

  it('accept de versión equivocada → 409 VERSION_STALE', async () => {
    const doc = await makeDoc();
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await publishVersion(T, v._id);
    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    await expect(
      recordAcceptance({
        tenantId: T,
        user,
        documentKey: 'terms-of-service',
        version: 99,
        ip: 'i',
        userAgent: 'u',
        locale: 'es',
      })
    ).rejects.toMatchObject({ code: 'VERSION_STALE' });
  });

  it('evidencia HMAC: verify válida y detecta manipulación', async () => {
    const doc = await makeDoc();
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await publishVersion(T, v._id);
    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    await recordAcceptance({
      tenantId: T,
      user,
      documentKey: 'terms-of-service',
      version: 1,
      ip: 'i',
      userAgent: 'u',
      locale: 'es',
    });
    const acc = await ComplianceAcceptance.findOne({ userId: user.id });
    expect((await verifyAcceptanceById(T, acc!._id)).valid).toBe(true);
    // Manipula el registro directamente y re-verifica.
    await ComplianceAcceptance.collection.updateOne({ _id: acc!._id }, { $set: { ip: '9.9.9.9' } });
    expect((await verifyAcceptanceById(T, acc!._id)).valid).toBe(false);
  });

  it('audience role:admin no aplica a un user', async () => {
    const doc = await makeDoc('block_full', 'role:admin');
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: true,
    });
    await publishVersion(T, v._id);
    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    const res = await getPendingForUser(T, user);
    expect(res.documents).toHaveLength(0);
  });

  it('publish atómico: re-publicar la misma versión falla (NOT_DRAFT)', async () => {
    const doc = await makeDoc();
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await publishVersion(T, v._id);
    await expect(publishVersion(T, v._id)).rejects.toMatchObject({ code: 'NOT_DRAFT' });
  });

  it('monotonic usa el MAYOR effectiveAt publicado, no la última versión (B P1 HIGH-1)', async () => {
    const doc = await makeDoc();
    // v1 effectiveAt=PAST2(2021), v2 effectiveAt=PAST(2020): publicar v1 luego v2 → v2 < maxEff(2021) → 409.
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST2,
    });
    await publishVersion(T, v1._id);
    const v2 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await expect(publishVersion(T, v2._id)).rejects.toMatchObject({
      code: 'EFFECTIVE_AT_NOT_MONOTONIC',
    });
    const after = await ComplianceDocument.findById(doc._id).lean();
    expect(after!.latestPublishedEffectiveAt).toEqual(PAST2); // max effectiveAt, no la última versión
  });

  it('recomputeDenorm limpia un current EXPIRADO (B P1 MEDIUM)', async () => {
    const doc = await makeDoc('soft');
    // Versión con ventana ya cerrada (effectiveAt y expiresAt en el pasado).
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      expiresAt: PAST2, // expira en 2021 → ya no vigente
    });
    await publishVersion(T, v._id);
    const after = await ComplianceDocument.findById(doc._id).lean();
    expect(after!.currentVersionNumber).toBe(0); // current limpiado por expiración
    expect(after!.currentVersionId).toBeNull();
    expect(after!.latestPublishedVersion).toBe(1); // sigue siendo la última publicada
  });

  it('accept de versión expirada → VERSION_STALE', async () => {
    const doc = await makeDoc('soft');
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      expiresAt: PAST2,
    });
    await publishVersion(T, v._id);
    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    await expect(
      recordAcceptance({
        tenantId: T,
        user,
        documentKey: 'terms-of-service',
        version: 1,
        ip: 'i',
        userAgent: 'u',
        locale: 'es',
      })
    ).rejects.toMatchObject({ code: 'VERSION_STALE' });
  });

  it('watermark monótono: publicar una futura más cercana tras una más lejana → 409 (B P1b HIGH-1)', async () => {
    const doc = await makeDoc();
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: FUTURE,
    });
    await publishVersion(T, v1._id);
    const after1 = await ComplianceDocument.findById(doc._id).lean();
    expect(after1!.latestPublishedEffectiveAt).toEqual(FUTURE); // watermark avanzó

    const v2 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: FUTURE_MID,
    });
    await expect(publishVersion(T, v2._id)).rejects.toMatchObject({
      code: 'EFFECTIVE_AT_NOT_MONOTONIC',
    });
    // El watermark NO retrocede.
    const after2 = await ComplianceDocument.findById(doc._id).lean();
    expect(after2!.latestPublishedEffectiveAt).toEqual(FUTURE);
  });

  it('PATCH→block_* fija enforcedVersion y un recompute concurrente NO lo revierte (D-032/D-027)', async () => {
    const doc = await makeDoc('soft');
    // Publica v1 SIN requiresReacceptance → enforcedVersion queda 0.
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: false,
    });
    await publishVersion(T, v._id);
    let d = await ComplianceDocument.findById(doc._id).lean();
    expect(d!.enforcedVersion).toBe(0);

    // El admin lo vuelve block_full → enforcedVersion sube a la versión vigente (1).
    await updateDocumentMetadata(T, doc._id, { enforcement: 'block_full' });
    d = await ComplianceDocument.findById(doc._id).lean();
    expect(d!.enforcedVersion).toBe(1);

    // Un recompute (concurrente/posterior) NO debe revertir el umbral a 0.
    await recomputeDenorm(doc._id);
    d = await ComplianceDocument.findById(doc._id).lean();
    expect(d!.enforcedVersion).toBe(1);

    // El gate bloquea a un usuario que no aceptó.
    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    const res = await getPendingForUser(T, user);
    expect(res.enforcement).toBe('block_full');
  });

  it('PATCH→block_* sin versión publicada → 409', async () => {
    const doc = await makeDoc('soft');
    await expect(
      updateDocumentMetadata(T, doc._id, { enforcement: 'block_full' })
    ).rejects.toMatchObject({
      code: 'NO_PUBLISHED_VERSION',
    });
  });

  it('soft enforcement: aparece como pending no-bloqueante', async () => {
    const doc = await makeDoc('soft');
    const v = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await publishVersion(T, v._id);
    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    const res = await getPendingForUser(T, user);
    expect(res.documents).toHaveLength(1);
    expect(res.documents[0].blocking).toBe(false);
    expect(res.enforcement).toBe('none'); // ningún bloqueante
  });

  // ───────────── Regresiones de la re-auditoría hostil (B-reaudit) ─────────────

  it('B-reaudit HIGH-1: publicar un número de versión MENOR tras uno mayor → 409 (ordinal monótono)', async () => {
    const doc = await makeDoc();
    // v1 (número 1) con effectiveAt POSTERIOR; v2 (número 2) con effectiveAt ANTERIOR.
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST2,
      requiresReacceptance: true,
    });
    const v2 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: true,
    });
    // Publicar v2 (número mayor) primero: OK.
    await publishVersion(T, v2._id);
    // Publicar v1 (número MENOR) después: aunque su effectiveAt (PAST2) supera el watermark (PAST), el
    // ordinal de versión retrocede (1 < 2) → rechazado. Sin este guard quedaba current=1 / enforced=2.
    await expect(publishVersion(T, v1._id)).rejects.toMatchObject({
      code: 'EFFECTIVE_AT_NOT_MONOTONIC',
    });
    // INVARIANTE de satisfacibilidad: enforcedVersion ≤ currentVersionNumber.
    const after = await ComplianceDocument.findById(doc._id).lean();
    expect(after!.enforcedVersion).toBeLessThanOrEqual(after!.currentVersionNumber);
    expect(after!.currentVersionNumber).toBe(2);
  });

  it('B-reaudit HIGH-2: un recompute STALE no revierte current* (guard por watermark de versión)', async () => {
    const doc = await makeDoc();
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await publishVersion(T, v1._id); // current=1, latestPublishedVersion=1
    // Simula que un publish de v2 (más nuevo) ya avanzó el denorm: current=2 y watermark=2, SIN que exista
    // una v2 publicada visible para un recompute que quedó atrás.
    await ComplianceDocument.updateOne(
      { _id: doc._id },
      { $set: { currentVersionNumber: 2, latestPublishedVersion: 2 } }
    );
    // Un recompute STALE (sólo ve v1 publicada, maxVersionSeen=1) NO debe pisar current=2 con current=1.
    await recomputeDenorm(doc._id);
    const after = await ComplianceDocument.findById(doc._id).lean();
    expect(after!.currentVersionNumber).toBe(2); // guard impidió el revert stale
  });

  it('B-reaudit HIGH-3: el reconciler autoritativo sana un watermark fantasma (recupera publish tras crash)', async () => {
    const doc = await makeDoc();
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await publishVersion(T, v1._id); // current=1, watermark=PAST/1
    const v2 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: FUTURE_MID,
      requiresReacceptance: true,
    });
    // Simula CRASH entre el watermark CAS y el status-flip: watermark adelantado a v2 pero v2 sigue DRAFT.
    await ComplianceDocument.updateOne(
      { _id: doc._id },
      { $set: { latestPublishedEffectiveAt: FUTURE_MID, latestPublishedVersion: 2 } }
    );
    // El watermark fantasma bloquea re-publicar v2 (ordinal 2 no supera el fantasma 2).
    await expect(publishVersion(T, v2._id)).rejects.toMatchObject({
      code: 'EFFECTIVE_AT_NOT_MONOTONIC',
    });
    // El reconciler de boot (autoritativo) resetea el watermark al máximo REAL entre PUBLICADAS (v1).
    await reconcileComplianceDenorm();
    const healed = await ComplianceDocument.findById(doc._id).lean();
    expect(healed!.latestPublishedVersion).toBe(1);
    // Ahora v2 vuelve a poder publicarse.
    await publishVersion(T, v2._id);
    const after = await ComplianceDocument.findById(doc._id).lean();
    expect(after!.latestPublishedVersion).toBe(2);
    expect(after!.nextVersionNumber).toBe(2); // FUTURE_MID → slot next
  });

  it('B-reaudit HIGH-3 residual: versión publicada no reflejada en denorm tras crash de recompute', async () => {
    const doc = await makeDoc();
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: true,
    });
    await publishVersion(T, v1._id);
    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    await recordAcceptance({
      tenantId: T,
      user,
      documentKey: 'terms-of-service',
      version: 1,
      ip: '1.2.3.4',
      userAgent: 'x',
      locale: 'es',
    });

    const v2 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST2,
      requiresReacceptance: true,
    });
    // Simula crash INMEDIATAMENTE DESPUÉS del status-flip: v2 queda publicada pero el recompute
    // no actualizó current*/next*/enforced*. El watermark sí avanzó en el CAS previo.
    await ComplianceVersion.updateOne(
      { _id: v2._id },
      { $set: { status: 'published', publishedAt: new Date() } }
    );
    await ComplianceDocument.updateOne(
      { _id: doc._id },
      { $set: { latestPublishedEffectiveAt: PAST2, latestPublishedVersion: 2 } }
    );

    const res = await getPendingForUser(T, user);
    expect(res.documents).toHaveLength(1);
    expect(res.documents[0].version).toBe(2);
  });

  it('B-reaudit verify HIGH: PRIMERA publicación stale (currentVersionNumber=0) NO bypassea block_full', async () => {
    // B 7/10: un block_full cuya PRIMERA versión crashea entre el status-flip y el recompute deja
    // currentVersionNumber=0 / latestPublishedVersion=1; el lazy-heal con guard `currentVersionNumber>0`
    // NO recomputaba → bypass total hasta el próximo boot. denormReflectedVersion lo cierra.
    const doc = await makeDoc(); // block_full
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: true,
    });
    // Simula crash tras el status-flip de la PRIMERA publicación, antes de recomputeDenorm: v1 queda
    // published y el watermark avanza, pero current*/enforced* siguen en 0 y denormReflectedVersion=0.
    await ComplianceVersion.updateOne(
      { _id: v1._id },
      { $set: { status: 'published', publishedAt: new Date() } }
    );
    await ComplianceDocument.updateOne(
      { _id: doc._id },
      { $set: { latestPublishedEffectiveAt: PAST, latestPublishedVersion: 1 } }
    );
    const fresh = await ComplianceDocument.findById(doc._id).lean();
    expect(fresh!.currentVersionNumber).toBe(0); // denorm stale (no reflejó la publicación)

    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    const res = await getPendingForUser(T, user);
    // El lazy-heal detecta latestPublishedVersion(1) > denormReflectedVersion(0) → recomputa → bloquea.
    expect(res.documents).toHaveLength(1);
    expect(res.documents[0].version).toBe(1);
    expect(res.documents[0].blocking).toBe(true);
    expect(res.enforcement).toBe('block_full');
  });

  it('B-reaudit verify: doc con versión vigente EXPIRADA no recomputa en bucle (reflected==latest)', async () => {
    // Contraparte: una denorm que SÍ procesó su última publicación (aunque ya expiró) no debe disparar
    // recompute en cada request (denormReflectedVersion == latestPublishedVersion).
    const doc = await makeDoc('soft');
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      expiresAt: PAST2, // ya expiró
    });
    await publishVersion(T, v1._id);
    const after = await ComplianceDocument.findById(doc._id).lean();
    expect(after!.currentVersionNumber).toBe(0); // expiró → sin current
    expect(after!.denormReflectedVersion).toBe(1); // pero la denorm SÍ procesó la v1
    expect(after!.latestPublishedVersion).toBe(1);
    // latestPublishedVersion(1) > denormReflectedVersion(1) es FALSO → no se considera stale.
    expect(after!.latestPublishedVersion > (after!.denormReflectedVersion ?? 0)).toBe(false);
  });

  it('B-reaudit verify HIGH: invariante block_* con enforcedVersion=0 auto-sana (crash en escritura de 2 pasos)', async () => {
    // Cubre las dos ventanas de B verify: (1) recompute que escribió current* pero crasheó antes de elevar
    // enforcedVersion; (2) updateDocumentMetadata que grabó block_full antes del raise. Estado residual:
    // block_full + current vigente + enforcedVersion=0 (no bloqueaba). El lazy-heal debe bootstrapear.
    const doc = await makeDoc(); // block_full
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
    });
    await publishVersion(T, v1._id);
    // Simula el residuo del crash: borra el umbral pero deja block_full + current vigente.
    await ComplianceDocument.updateOne(
      { _id: doc._id },
      { $set: { enforcedVersion: 0, enforcedFrom: null } }
    );
    const stale = await ComplianceDocument.findById(doc._id).lean();
    expect(stale!.enforcement).toBe('block_full');
    expect(stale!.enforcedVersion).toBe(0); // estado roto: bloqueante sin umbral

    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    const res = await getPendingForUser(T, user);
    expect(res.documents).toHaveLength(1);
    expect(res.documents[0].blocking).toBe(true); // el invariante recomputó y bootstrapeó enforcedVersion
    expect(res.enforcement).toBe('block_full');
  });

  it('B-reaudit verify HIGH residual: block_* con enforcedVersion inexistente (lean undefined) se auto-sana', async () => {
    // El invariante anterior usaba `enforcedVersion === 0`, pero `.lean()` no aplica defaults → un doc
    // preexistente sin el campo devuelve `undefined`, el invariante NO saltaba y el gate NO bloqueaba.
    // `$in: [0, null]` en los guards de elección cubre el campo inexistente.
    const doc = await makeDoc(); // block_full
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: true,
    });
    await publishVersion(T, v1._id);
    // Simula doc preexistente sin el campo enforcedVersion.
    await ComplianceDocument.updateOne({ _id: doc._id }, { $unset: { enforcedVersion: 1 } });
    const stale = await ComplianceDocument.findById(doc._id).lean();
    expect(stale!.enforcedVersion).toBeUndefined();

    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    const res = await getPendingForUser(T, user);
    expect(res.documents).toHaveLength(1);
    expect(res.documents[0].blocking).toBe(true);
    expect(res.enforcement).toBe('block_full');

    const healed = await ComplianceDocument.findById(doc._id).lean();
    expect(healed!.enforcedVersion).toBe(1);
  });

  it('B-reaudit verify HIGH residual: recomputeDenorm bootstrapea enforcedVersion inexistente (requiresReacceptance=false)', async () => {
    // Variante por el path de bootstrap: cuando ninguna versión vigente pide reaceptación, el umbral se
    // eleva vía `else if (current)`. También debe cubrir el campo inexistente.
    const doc = await makeDoc(); // block_full
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: false,
    });
    await publishVersion(T, v1._id);
    await ComplianceDocument.updateOne({ _id: doc._id }, { $unset: { enforcedVersion: 1 } });

    await recomputeDenorm(doc._id);
    const healed = await ComplianceDocument.findById(doc._id).lean();
    expect(healed!.enforcedVersion).toBe(1);
  });

  it('B-reaudit MED-5: getPendingForUser devuelve recheckAt cuando hay una versión programada futura', async () => {
    const doc = await makeDoc();
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: true,
    });
    await publishVersion(T, v1._id);
    const user = { id: new mongoose.Types.ObjectId(), email: 'u@test', role: 'user' as const };
    await recordAcceptance({
      tenantId: T,
      user,
      documentKey: doc.key,
      version: 1,
      ip: '1.2.3.4',
      userAgent: 'x',
      locale: 'es',
    });
    // Programa v2 para el futuro (block_full reaceptación).
    const v2 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: FUTURE_MID,
      requiresReacceptance: true,
    });
    await publishVersion(T, v2._id);
    const res = await getPendingForUser(T, user);
    expect(res.documents).toHaveLength(0); // conforme con la current (v1)
    expect(res.recheckAt).toEqual(FUTURE_MID); // el gate acotará su caché a este instante
  });

  it('B-reaudit v3 HIGH: updateDocumentMetadata NO degrada enforcedVersion ante un publish concurrente', async () => {
    // Reproduce de forma DETERMINISTA la carrera de downgrade de B: el doc se carga con enforcedVersion
    // bajo, un publish concurrente sube el umbral en DB ENTRE la carga y el save, y `doc.save()` NO debe
    // re-persistir el valor viejo. El fix es order-independent: nunca se modifica enforcedVersion en el
    // objeto Mongoose. Si alguien revierte el fix (reflejar+re-save), este test FALLA (señal anti-regresión).
    const doc = await makeDoc('soft');
    const v1 = await createDraftVersion({
      tenantId: T,
      documentId: doc._id,
      contents: content,
      effectiveAt: PAST,
      requiresReacceptance: false, // soft + sin reaceptación → enforcedVersion arranca en 0
    });
    await publishVersion(T, v1._id);

    // Spy de findOne: en la PRIMERA llamada (la carga interna de updateDocumentMetadata) simula un publish
    // concurrente que eleva enforcedVersion a 9 en DB justo después de leer el doc (que ve enforcedVersion=0).
    const origFindOne = ComplianceDocument.findOne.bind(ComplianceDocument);
    const spy = vi.spyOn(ComplianceDocument, 'findOne').mockImplementationOnce(((
      filter: unknown
    ) => {
      return (async () => {
        const loaded = await origFindOne(filter as never);
        await ComplianceDocument.collection.updateOne(
          { _id: doc._id },
          { $set: { enforcedVersion: 9 } }
        );
        return loaded;
      })();
    }) as unknown as typeof ComplianceDocument.findOne);

    try {
      await updateDocumentMetadata(T, doc._id, { enforcement: 'block_full' });
    } finally {
      spy.mockRestore();
    }

    const after = await ComplianceDocument.findById(doc._id).lean();
    expect(after!.enforcedVersion).toBe(9); // NUNCA rebajado a 1 por el save() de la metadata
  });
});
