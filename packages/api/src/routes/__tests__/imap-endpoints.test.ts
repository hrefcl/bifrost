import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Mocks de servicios externos (hoisted por vitest). Factories sin refs externas.
vi.mock('imapflow', () => {
  class ImapFlow {
    constructor(_opts: unknown) {}
    async connect(): Promise<void> {}
    async logout(): Promise<void> {}
    async list() {
      return [
        {
          path: 'INBOX',
          name: 'INBOX',
          delimiter: '/',
          parentPath: '',
          flags: new Set<string>(),
          specialUse: '\\Inbox',
        },
      ];
    }
    async getMailboxLock() {
      return { release: () => undefined };
    }
    fetch() {
      // async iterable vacío (sin headers para sincronizar en este test)
      return (async function* () {
        /* vacío */
      })();
    }
    async messageFlagsAdd(): Promise<boolean> {
      return true;
    }
    async messageFlagsRemove(): Promise<boolean> {
      return true;
    }
    async messageMove(): Promise<{ uidMap: Map<number, number> }> {
      return { uidMap: new Map() };
    }
    async fetchOne(uid: number) {
      // uid sentinel 999 → simula mensaje inexistente en el servidor (miss).
      if (uid === 999) return false;
      // Mensaje multipart real: cuerpo de texto + 1 adjunto.
      const src = [
        'Subject: hola',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'cuerpo de prueba',
        '--b1',
        'Content-Type: text/plain; name="hello.txt"',
        'Content-Disposition: attachment; filename="hello.txt"',
        '',
        'contenido-adjunto',
        '--b1--',
        '',
      ].join('\r\n');
      return { source: Buffer.from(src) };
    }
  }
  return { ImapFlow };
});

vi.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: () => Promise.resolve({ messageId: '<mock@test>' }),
    close: () => undefined,
  }),
}));

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
import { Folder } from '../../models/Folder.js';
import { Email } from '../../models/Email.js';

describe('endpoints con IMAP (F3.1, mocks)', () => {
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

  it('POST /api/auth/login (ruta pública, sin token) funciona end-to-end', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'newuser@test.com',
        password: 'secret-pass',
        imapHost: 'imap.test',
        imapPort: 993,
        imapSecure: true,
        smtpHost: 'smtp.test',
        smtpPort: 465,
        smtpSecure: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { accessToken: string; user: { primaryEmail: string } };
    expect(body.accessToken).toBeTruthy();
    expect(body.user.primaryEmail).toBe('newuser@test.com');
  });

  it('dos logins concurrentes del mismo email nuevo → ambos 200, un solo usuario (M-USER-RACE)', async () => {
    const payload = {
      email: 'race@test.com',
      password: 'secret-pass',
      imapHost: 'imap.test',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.test',
      smtpPort: 465,
      smtpSecure: true,
    };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/auth/login', payload }),
      app.inject({ method: 'POST', url: '/api/auth/login', payload }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const { User } = await import('../../models/User.js');
    const { Account } = await import('../../models/Account.js');
    expect(await User.countDocuments({ primaryEmail: 'race@test.com' })).toBe(1);
    expect(await Account.countDocuments({ email: 'race@test.com' })).toBe(1);
  });

  it('GET /api/emails/:id/body — parsea (postal-mime), sanitiza y cachea', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'owner@test.com' });
    const folder = await seedFolder(account._id);
    const email = await seedEmail(account._id, folder._id, { uid: 5 });
    const res = await app.inject({
      method: 'GET',
      url: `/api/emails/${email._id.toString()}/body`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { text?: string; html?: string; sanitizedHtml?: string };
    expect(body.text).toContain('cuerpo de prueba');
    expect(body.html).toBeUndefined(); // no se devuelve html crudo (PRODUCT DECISION)
    // metadata actualizada en el doc
    const { Email } = await import('../../models/Email.js');
    const updated = await Email.findById(email._id);
    expect(updated?.bodyCached).toBe(true);
    expect(updated?.hasAttachments).toBe(true);
    expect(updated?.attachmentCount).toBe(1);
    expect(updated?.preview).toContain('cuerpo de prueba');
  });

  it('GET /api/emails/:id/attachments — lista metadata de adjuntos', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'owner@test.com' });
    const folder = await seedFolder(account._id);
    const email = await seedEmail(account._id, folder._id, { uid: 6 });
    const res = await app.inject({
      method: 'GET',
      url: `/api/emails/${email._id.toString()}/attachments`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body) as Array<{
      id: string;
      filename: string;
      contentType: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: '0', filename: 'hello.txt', contentType: 'text/plain' });
  });

  it('GET /api/emails/:id/attachments/:id — descarga el adjunto', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'owner@test.com' });
    const folder = await seedFolder(account._id);
    const email = await seedEmail(account._id, folder._id, { uid: 7 });
    const res = await app.inject({
      method: 'GET',
      url: `/api/emails/${email._id.toString()}/attachments/0`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    // Seguridad: siempre descarga (attachment) + nosniff, nunca inline.
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).toContain('hello.txt');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toContain('contenido-adjunto');
  });

  it('GET /api/emails/:id/body — miss del servidor → 404 y NO pisa metadata', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'owner@test.com' });
    const folder = await seedFolder(account._id);
    const email = await seedEmail(account._id, folder._id, { uid: 999 }); // sentinel miss
    const res = await app.inject({
      method: 'GET',
      url: `/api/emails/${email._id.toString()}/body`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(404);
    const { Email } = await import('../../models/Email.js');
    const after = await Email.findById(email._id);
    // metadata intacta (no se marcó bodyCached ni se borró preview)
    expect(after?.bodyCached).toBe(false);
  });

  it('PATCH /api/emails/:id/flags marca leído (DB + IMAP)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'owner@test.com' });
    const folder = await seedFolder(account._id);
    const email = await seedEmail(account._id, folder._id, { uid: 20 });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/emails/${email._id.toString()}/flags`,
      headers: authHeaders(app, user._id.toString()),
      payload: { seen: true },
    });
    expect(res.statusCode).toBe(200);
    const { Email } = await import('../../models/Email.js');
    expect((await Email.findById(email._id))?.flags.seen).toBe(true);
  });

  it('DELETE /api/emails/:id mueve a Trash y borra de la DB', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'owner@test.com' });
    const folder = await seedFolder(account._id);
    const email = await seedEmail(account._id, folder._id, { uid: 21 });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/emails/${email._id.toString()}`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    const { Email } = await import('../../models/Email.js');
    expect(await Email.findById(email._id)).toBeNull();
  });

  it('PATCH /api/emails/:id/flags ajeno → 404 (authz)', async () => {
    const a = await seedUserWithAccount({ email: 'a@test.com' });
    const b = await seedUserWithAccount({ email: 'b@test.com' });
    const folder = await seedFolder(a.account._id);
    const email = await seedEmail(a.account._id, folder._id, { uid: 22 });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/emails/${email._id.toString()}/flags`,
      headers: authHeaders(app, b.user._id.toString()),
      payload: { seen: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/emails/:id/attachments/99 inexistente → 404', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'owner@test.com' });
    const folder = await seedFolder(account._id);
    const email = await seedEmail(account._id, folder._id, { uid: 8 });
    const res = await app.inject({
      method: 'GET',
      url: `/api/emails/${email._id.toString()}/attachments/99`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/accounts/:id/sync/folders — dueño 200 sincroniza folders', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'owner@test.com' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account._id.toString()}/sync/folders`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { synced: number }).synced).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/accounts/:id/folders/:fid/sync — dueño 200', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'owner@test.com' });
    const folder = await seedFolder(account._id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account._id.toString()}/folders/${folder._id.toString()}/sync`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/emails/:id/move — archiva (mueve a Archive), saca el doc local; owner-bound', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'mv@test.com' });
    // Índice único (accountId, specialUse) → cada carpeta de sistema con su specialUse propio.
    const inbox = await seedFolder(account._id, { name: 'INBOX', path: 'INBOX' });
    await Folder.updateOne({ _id: inbox._id }, { specialUse: 'inbox' });
    const archive = await seedFolder(account._id, { name: 'Archive', path: 'Archive' });
    await Folder.updateOne({ _id: archive._id }, { specialUse: 'archive' });
    const email = await seedEmail(account._id, inbox._id, { uid: 20 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/emails/${email._id.toString()}/move`,
      headers: authHeaders(app, user._id.toString()),
      payload: { specialUse: 'archive' },
    });
    expect(res.statusCode).toBe(200);
    // El uid cambia en el destino → el doc local se quita (se re-sincroniza al sincronizar Archive).
    expect(await Email.findById(email._id)).toBeNull();

    // Carpeta destino inexistente → 404 (no se pierde el email).
    const email2 = await seedEmail(account._id, inbox._id, { uid: 21 });
    const noTarget = await app.inject({
      method: 'POST',
      url: `/api/emails/${email2._id.toString()}/move`,
      headers: authHeaders(app, user._id.toString()),
      payload: { specialUse: 'junk' }, // no hay carpeta junk sembrada
    });
    expect(noTarget.statusCode).toBe(404);
    expect(await Email.findById(email2._id)).not.toBeNull();

    // Owner-bound: OTRO usuario no puede mover este email (no fuga cross-tenant).
    const { user: other } = await seedUserWithAccount({ email: 'mv-other@test.com' });
    const cross = await app.inject({
      method: 'POST',
      url: `/api/emails/${email2._id.toString()}/move`,
      headers: authHeaders(app, other._id.toString()),
      payload: { specialUse: 'archive' },
    });
    expect([403, 404]).toContain(cross.statusCode);
    expect(await Email.findById(email2._id)).not.toBeNull();
  });

  it('PATCH /api/emails/:id/flags — persiste flagged (estrella) y seen; vacío → 400', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'star@test.com' });
    const folder = await seedFolder(account._id);
    const email = await seedEmail(account._id, folder._id, { uid: 30 });
    const headers = authHeaders(app, user._id.toString());
    const url = `/api/emails/${email._id.toString()}/flags`;

    // flagged: la estrella (antes la ruta sólo aceptaba `seen` → el star nunca persistía).
    const star = await app.inject({ method: 'PATCH', url, headers, payload: { flagged: true } });
    expect(star.statusCode).toBe(200);
    expect((await Email.findById(email._id))?.flags.flagged).toBe(true);

    // seen sigue funcionando.
    const seen = await app.inject({ method: 'PATCH', url, headers, payload: { seen: true } });
    expect(seen.statusCode).toBe(200);
    expect((await Email.findById(email._id))?.flags.seen).toBe(true);

    // body sin seen ni flagged → 400.
    const empty = await app.inject({ method: 'PATCH', url, headers, payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it('GET /api/emails/search — matchea asunto (owner-bound, regex escapado)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'srch@test.com' });
    const folder = await seedFolder(account._id);
    await seedEmail(account._id, folder._id, { uid: 40, subject: 'Factura de junio' });
    await seedEmail(account._id, folder._id, { uid: 41, subject: 'Reunión de equipo' });
    const headers = authHeaders(app, user._id.toString());

    const res = await app.inject({ method: 'GET', url: '/api/emails/search?q=factura', headers });
    expect(res.statusCode).toBe(200);
    const got = (JSON.parse(res.body) as { data: { subject: string }[] }).data.map(
      (e) => e.subject
    );
    expect(got).toContain('Factura de junio');
    expect(got).not.toContain('Reunión de equipo');

    // Regex ESCAPADO: '.*' se busca literal (no matchea todo).
    const star = await app.inject({
      method: 'GET',
      url: `/api/emails/search?q=${encodeURIComponent('.*')}`,
      headers,
    });
    expect((JSON.parse(star.body) as { data: unknown[] }).data).toHaveLength(0);

    // Owner-bound: otro usuario no ve estos emails.
    const { user: other } = await seedUserWithAccount({ email: 'srch-other@test.com' });
    const cross = await app.inject({
      method: 'GET',
      url: '/api/emails/search?q=factura',
      headers: authHeaders(app, other._id.toString()),
    });
    expect((JSON.parse(cross.body) as { data: unknown[] }).data).toHaveLength(0);
  });
});
