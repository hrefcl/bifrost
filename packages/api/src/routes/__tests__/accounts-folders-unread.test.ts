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
 * GET /api/accounts/:id/folders — el badge de no-leídos debe ser CONSCIENTE DE SNOOZE (paridad
 * Gmail). `unseenMessages` viene del sync IMAP y cuenta todos los no-leídos, pero los pospuestos
 * están ocultos de la carpeta: si no se restan, posponer un no-leído infla el badge respecto a la
 * lista visible. Aquí se verifica que el endpoint resta exactamente los no-leídos ocultos por snooze.
 */
describe('GET /api/accounts/:id/folders — badge de no-leídos consciente de snooze', () => {
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

  it('resta del badge los no-leídos pospuestos; deja intactos los visibles', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge@test.com' });
    const inbox = await seedFolder(account._id);
    // IMAP reportó 3 no-leídos en la carpeta.
    await Folder.updateOne({ _id: inbox._id }, { unseenMessages: 3 });
    const e1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    await seedEmail(account._id, inbox._id, { uid: 2 });
    await seedEmail(account._id, inbox._id, { uid: 3 });
    // Posponer e1 (no-leído) → oculto de la carpeta y NO debe contar en el badge.
    await Email.updateOne({ _id: e1._id }, { snoozedUntil: new Date(Date.now() + 60 * 60 * 1000) });

    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${account._id.toString()}/folders`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    const folders = JSON.parse(res.body) as { id: string; unseenMessages: number }[];
    const inboxDto = folders.find((f) => f.id === inbox._id.toString());
    expect(inboxDto?.unseenMessages).toBe(2); // 3 IMAP − 1 pospuesto-no-leído.
  });

  it('un pospuesto YA LEÍDO no se resta (sólo cuentan los no-leídos ocultos)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge2@test.com' });
    const inbox = await seedFolder(account._id);
    await Folder.updateOne({ _id: inbox._id }, { unseenMessages: 1 });
    const seen = await seedEmail(account._id, inbox._id, { uid: 1 });
    await Email.updateOne(
      { _id: seen._id },
      { 'flags.seen': true, snoozedUntil: new Date(Date.now() + 60 * 60 * 1000) }
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${account._id.toString()}/folders`,
      headers: authHeaders(app, user._id.toString()),
    });
    const folders = JSON.parse(res.body) as { id: string; unseenMessages: number }[];
    expect(folders.find((f) => f.id === inbox._id.toString())?.unseenMessages).toBe(1);
  });

  it('snoozedUntil PASADO (vencido) NO se resta: el email ya reapareció en la carpeta', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-past@test.com' });
    const inbox = await seedFolder(account._id);
    await Folder.updateOne({ _id: inbox._id }, { unseenMessages: 2 });
    const e1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    await seedEmail(account._id, inbox._id, { uid: 2 });
    // snooze vencido → ya NO está oculto → debe contar como no-leído visible.
    await Email.updateOne({ _id: e1._id }, { snoozedUntil: new Date(Date.now() - 1000) });

    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${account._id.toString()}/folders`,
      headers: authHeaders(app, user._id.toString()),
    });
    const folders = JSON.parse(res.body) as { id: string; unseenMessages: number }[];
    expect(folders.find((f) => f.id === inbox._id.toString())?.unseenMessages).toBe(2);
  });

  it('multi-carpeta: un pospuesto en la carpeta A no afecta el badge de la carpeta B', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-multi@test.com' });
    // specialUse distintos desde el create: el índice único {accountId, specialUse} no admite dos
    // null por cuenta (seedFolder deja specialUse null, así que aquí creamos directo).
    const base = {
      accountId: account._id,
      delimiter: '/',
      flags: [],
      uidValidity: 0,
      uidNext: 0,
      totalMessages: 0,
      unseenMessages: 2,
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
    await seedEmail(account._id, work._id, { uid: 2 });
    await Email.updateOne({ _id: a1._id }, { snoozedUntil: new Date(Date.now() + 3600_000) });

    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${account._id.toString()}/folders`,
      headers: authHeaders(app, user._id.toString()),
    });
    const folders = JSON.parse(res.body) as { id: string; unseenMessages: number }[];
    expect(folders.find((f) => f.id === inbox._id.toString())?.unseenMessages).toBe(1); // 2−1
    expect(folders.find((f) => f.id === work._id.toString())?.unseenMessages).toBe(2); // intacto
  });

  it('owner-bound: el snooze de OTRA cuenta no afecta mi badge', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge-me@test.com' });
    const { account: other } = await seedUserWithAccount({ email: 'badge-other@test.com' });
    const myInbox = await seedFolder(account._id);
    const otherInbox = await seedFolder(other._id);
    await Folder.updateOne({ _id: myInbox._id }, { unseenMessages: 2 });
    // El otro usuario pospone no-leídos en SU carpeta; no debe tocar mi conteo.
    const o1 = await seedEmail(other._id, otherInbox._id, { uid: 1 });
    const o2 = await seedEmail(other._id, otherInbox._id, { uid: 2 });
    const until = new Date(Date.now() + 3600_000);
    await Email.updateOne({ _id: o1._id }, { snoozedUntil: until });
    await Email.updateOne({ _id: o2._id }, { snoozedUntil: until });

    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${account._id.toString()}/folders`,
      headers: authHeaders(app, user._id.toString()),
    });
    const folders = JSON.parse(res.body) as { id: string; unseenMessages: number }[];
    expect(folders.find((f) => f.id === myInbox._id.toString())?.unseenMessages).toBe(2); // sin tocar
  });

  it('clamp a 0 si los ocultos exceden el conteo IMAP (sin negativos)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'badge3@test.com' });
    const inbox = await seedFolder(account._id);
    await Folder.updateOne({ _id: inbox._id }, { unseenMessages: 1 });
    const e1 = await seedEmail(account._id, inbox._id, { uid: 1 });
    const e2 = await seedEmail(account._id, inbox._id, { uid: 2 });
    const until = new Date(Date.now() + 60 * 60 * 1000);
    await Email.updateOne({ _id: e1._id }, { snoozedUntil: until });
    await Email.updateOne({ _id: e2._id }, { snoozedUntil: until });

    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${account._id.toString()}/folders`,
      headers: authHeaders(app, user._id.toString()),
    });
    const folders = JSON.parse(res.body) as { id: string; unseenMessages: number }[];
    expect(folders.find((f) => f.id === inbox._id.toString())?.unseenMessages).toBe(0);
  });
});
