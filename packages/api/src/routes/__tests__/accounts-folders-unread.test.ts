import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
  seedFolder,
  seedEmail,
} from '../../../test/integration-helper.js';
import type { FastifyInstance } from 'fastify';
import { Folder } from '../../models/Folder.js';
import { Email } from '../../models/Email.js';

/**
 * GET /api/accounts/:id/folders — el badge de no-leídos (`unseenMessages`) es AUTORITATIVO: cuenta
 * los emails realmente VISIBLES y no-leídos por carpeta (flags.seen=false Y no pospuestos), el mismo
 * criterio que la lista. Refleja al instante marcar-leído/borrar/mover/snooze/unsnooze porque cuenta
 * documentos Email reales — NO usa Folder.unseenMessages (sync IMAP, que no se actualiza al marcar
 * leído/borrar/mover hasta el próximo sync, y dejaba el badge inflado de forma persistente). Review B.
 */
describe('GET /api/accounts/:id/folders — badge de no-leídos autoritativo (conteo real)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    await setupTestDb();
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  const badgeOf = async (userId: string, accountId: string, folderId: string): Promise<number> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${accountId}/folders`,
      headers: authHeaders(app, userId),
    });
    expect(res.statusCode).toBe(200);
    const folders = JSON.parse(res.body) as { id: string; unseenMessages: number }[];
    return folders.find((f) => f.id === folderId)?.unseenMessages ?? -1;
  };

  it('cuenta los no-leídos visibles; excluye los pospuestos', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge@test.com' });
    const inbox = await seedFolder(account._id);
    // Folder.unseenMessages se setea a un valor ENGAÑOSO a propósito: el badge NO debe usarlo.
    await Folder.updateOne({ _id: inbox._id }, { unseenMessages: 99 });
    const e1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    await seedEmail(account._id, inbox._id, { uid: 2 });
    await seedEmail(account._id, inbox._id, { uid: 3 });
    await Email.updateOne({ _id: e1._id }, { snoozedUntil: new Date(Date.now() + 3600_000) });

    // 3 no-leídos, 1 pospuesto → 2 visibles (NO 99 de Folder.unseenMessages).
    expect(await badgeOf(user._id.toString(), account._id.toString(), inbox._id.toString())).toBe(
      2
    );
  });

  it('marcar leído BAJA el badge al instante (no depende del sync IMAP) — regresión B', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-read@test.com' });
    const inbox = await seedFolder(account._id);
    await Folder.updateOne({ _id: inbox._id }, { unseenMessages: 2 });
    const e1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    await seedEmail(account._id, inbox._id, { uid: 2 });
    expect(await badgeOf(user._id.toString(), account._id.toString(), inbox._id.toString())).toBe(
      2
    );

    // Marcar uno como leído → badge baja YA (antes quedaba en 2 hasta el próximo sync).
    await Email.updateOne({ _id: e1._id }, { 'flags.seen': true });
    expect(await badgeOf(user._id.toString(), account._id.toString(), inbox._id.toString())).toBe(
      1
    );
  });

  it('un email LEÍDO y pospuesto cuenta 0 (no infla el badge de 0 a 1) — regresión B', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-seen-snz@test.com' });
    const inbox = await seedFolder(account._id);
    await Folder.updateOne({ _id: inbox._id }, { unseenMessages: 1 });
    const e1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    await Email.updateOne(
      { _id: e1._id },
      { 'flags.seen': true, snoozedUntil: new Date(Date.now() + 3600_000) }
    );
    expect(await badgeOf(user._id.toString(), account._id.toString(), inbox._id.toString())).toBe(
      0
    );
  });

  it('snoozedUntil VENCIDO cuenta (el email ya reapareció en la carpeta)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-past@test.com' });
    const inbox = await seedFolder(account._id);
    const e1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    await seedEmail(account._id, inbox._id, { uid: 2 });
    await Email.updateOne({ _id: e1._id }, { snoozedUntil: new Date(Date.now() - 1000) });
    expect(await badgeOf(user._id.toString(), account._id.toString(), inbox._id.toString())).toBe(
      2
    );
  });

  it('multi-carpeta: cada carpeta cuenta sólo lo suyo', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-multi@test.com' });
    const base = {
      accountId: account._id,
      delimiter: '/',
      flags: [],
      uidValidity: 0,
      uidNext: 0,
      totalMessages: 0,
      unseenMessages: 0,
      subscribed: true,
      sortOrder: 0,
      expanded: false,
      syncedAt: new Date(),
    };
    const inbox = await Folder.create({
      ...base,
      name: 'INBOX',
      path: 'INBOX',
      displayName: 'INBOX',
      specialUse: 'inbox',
    });
    const work = await Folder.create({
      ...base,
      name: 'Work',
      path: 'Work',
      displayName: 'Work',
      specialUse: 'junk',
    });
    const a1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    await seedEmail(account._id, inbox._id, { uid: 2 });
    await seedEmail(account._id, work._id, { uid: 3 });
    await Email.updateOne({ _id: a1._id }, { snoozedUntil: new Date(Date.now() + 3600_000) });

    const uid = user._id.toString();
    expect(await badgeOf(uid, account._id.toString(), inbox._id.toString())).toBe(1); // 2 − 1 snoozed
    expect(await badgeOf(uid, account._id.toString(), work._id.toString())).toBe(1);
  });

  it('owner-bound: los emails de OTRA cuenta no cuentan en mi badge', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-me@test.com' });
    const { account: other } = await seedUserWithAccount({ email: 'badge-other@test.com' });
    const myInbox = await seedFolder(account._id);
    const otherInbox = await seedFolder(other._id);
    await seedEmail(account._id, myInbox._id, { uid: 1 }); // 1 mío
    await seedEmail(other._id, otherInbox._id, { uid: 2 }); // del otro
    await seedEmail(other._id, otherInbox._id, { uid: 3 });

    expect(await badgeOf(user._id.toString(), account._id.toString(), myInbox._id.toString())).toBe(
      1
    ); // sólo el mío
  });

  // delete y move terminan ambos en `Email.deleteOne` sobre la carpeta ORIGEN (DELETE → Papelera;
  // POST /move → carpeta destino), tras la operación IMAP. Como el badge cuenta documentos Email,
  // basta con simular ese efecto a nivel doc (sin acoplar este test al mock de IMAP) para probar que
  // el conteo refleja ambas acciones — regresión B (el contador no quedaba inflado tras delete/move).
  it('borrar un no-leído baja el badge de su carpeta (el doc deja de contar) — regresión B', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-del@test.com' });
    const inbox = await seedFolder(account._id);
    const e1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    await seedEmail(account._id, inbox._id, { uid: 2 });
    const uid = user._id.toString();
    expect(await badgeOf(uid, account._id.toString(), inbox._id.toString())).toBe(2);

    await Email.deleteOne({ _id: e1._id }); // efecto de DELETE /emails/:id sobre la carpeta origen
    expect(await badgeOf(uid, account._id.toString(), inbox._id.toString())).toBe(1);
  });

  it('mover un no-leído baja el badge de la carpeta ORIGEN — regresión B', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-move@test.com' });
    const inbox = await seedFolder(account._id);
    const e1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    await seedEmail(account._id, inbox._id, { uid: 2 });
    const uid = user._id.toString();
    expect(await badgeOf(uid, account._id.toString(), inbox._id.toString())).toBe(2);

    await Email.deleteOne({ _id: e1._id }); // efecto de POST /move sobre la carpeta origen
    expect(await badgeOf(uid, account._id.toString(), inbox._id.toString())).toBe(1);
  });

  it('carpeta sin no-leídos visibles → badge 0', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-zero@test.com' });
    const inbox = await seedFolder(account._id);
    await Folder.updateOne({ _id: inbox._id }, { unseenMessages: 5 }); // IMAP engañoso
    const e1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    await Email.updateOne({ _id: e1._id }, { snoozedUntil: new Date(Date.now() + 3600_000) });
    expect(await badgeOf(user._id.toString(), account._id.toString(), inbox._id.toString())).toBe(
      0
    );
  });
});
