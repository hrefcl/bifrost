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
