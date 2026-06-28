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
  seedAccountFor,
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

  it('POST /api/emails/:id/move por folderId — mueve a una carpeta-etiqueta; folderId de otra cuenta → 404', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'lbl@test.com' });
    const inbox = await seedFolder(account._id, { name: 'INBOX', path: 'INBOX' });
    await Folder.updateOne({ _id: inbox._id }, { specialUse: 'inbox' });
    // Carpeta-etiqueta SIN specialUse (lo que el front muestra como "etiqueta").
    const label = await seedFolder(account._id, { name: 'Proyectos', path: 'Proyectos' });
    const email = await seedEmail(account._id, inbox._id, { uid: 30 });
    const headers = authHeaders(app, user._id.toString());

    const ok = await app.inject({
      method: 'POST',
      url: `/api/emails/${email._id.toString()}/move`,
      headers,
      payload: { folderId: label._id.toString() },
    });
    expect(ok.statusCode).toBe(200);
    expect(await Email.findById(email._id)).toBeNull(); // salió de INBOX hacia la etiqueta

    // SEGURIDAD: mover a una carpeta de OTRA cuenta (folderId ajeno) → 404 (la búsqueda de carpeta
    // está acotada a la cuenta del email; no se puede inyectar destino cross-tenant).
    const { account: other } = await seedUserWithAccount({ email: 'lbl-other@test.com' });
    const otherFolder = await seedFolder(other._id, { name: 'Ajena', path: 'Ajena' });
    const email2 = await seedEmail(account._id, inbox._id, { uid: 31 });
    const crossFolder = await app.inject({
      method: 'POST',
      url: `/api/emails/${email2._id.toString()}/move`,
      headers,
      payload: { folderId: otherFolder._id.toString() },
    });
    expect(crossFolder.statusCode).toBe(404);
    expect(await Email.findById(email2._id)).not.toBeNull(); // no se movió
  });

  it('GET folders/:id/emails?filter — filtra SERVER-SIDE (toda la carpeta) con total honesto', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'flt@test.com' });
    const inbox = await seedFolder(account._id, { name: 'INBOX', path: 'INBOX' });
    const e1 = await seedEmail(account._id, inbox._id, { uid: 40 }); // no leído (default)
    const e2 = await seedEmail(account._id, inbox._id, { uid: 41 }); // leído + destacado
    const e3 = await seedEmail(account._id, inbox._id, { uid: 42 }); // leído + con adjunto
    await Email.updateOne({ _id: e1._id }, { 'flags.seen': false });
    await Email.updateOne({ _id: e2._id }, { 'flags.seen': true, 'flags.flagged': true });
    await Email.updateOne({ _id: e3._id }, { 'flags.seen': true, hasAttachments: true });
    const headers = authHeaders(app, user._id.toString());
    const base = `/api/accounts/${account._id.toString()}/folders/${inbox._id.toString()}/emails`;
    const get = async (qs: string) => {
      const res = await app.inject({ method: 'GET', url: base + qs, headers });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as {
        data: { uid: number }[];
        pagination: { total: number };
      };
    };

    const all = await get('');
    expect(all.pagination.total).toBe(3);

    const unread = await get('?filter=unread');
    expect(unread.data.map((e) => e.uid)).toEqual([40]);
    expect(unread.pagination.total).toBe(1); // total honesto: TODA la carpeta, no la página

    const starred = await get('?filter=starred');
    expect(starred.data.map((e) => e.uid)).toEqual([41]);

    const attachments = await get('?filter=attachments');
    expect(attachments.data.map((e) => e.uid)).toEqual([42]);

    // filtro inválido → 400 (zod enum).
    const bad = await app.inject({ method: 'GET', url: base + '?filter=bogus', headers });
    expect(bad.statusCode).toBe(400);
  });

  it('GET folders/:id/emails — paginación por CURSOR/keyset (contrato de "cargar más")', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'page@test.com' });
    const inbox = await seedFolder(account._id);
    // 3 emails; uid mayor = más nuevo (orden date desc, uid desc → 52, 51, 50).
    const dates = new Map<number, string>();
    for (let i = 0; i < 3; i++) {
      const uid = 50 + i;
      const e = await seedEmail(account._id, inbox._id, { uid });
      const d = new Date(Date.now() - (2 - i) * 60_000);
      await Email.updateOne({ _id: e._id }, { date: d });
      dates.set(uid, d.toISOString());
    }
    const headers = authHeaders(app, user._id.toString());
    const base = `/api/accounts/${account._id.toString()}/folders/${inbox._id.toString()}/emails`;
    const page = async (qs: string) => {
      const res = await app.inject({ method: 'GET', url: base + qs, headers });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as {
        data: { uid: number; date: string }[];
        pagination: { total?: number; hasMore: boolean };
      };
    };

    const p1 = await page('?limit=2');
    expect(p1.data.map((e) => e.uid)).toEqual([52, 51]); // 2 más nuevos
    expect(p1.pagination).toMatchObject({ total: 3, hasMore: true }); // total sólo en 1ª página

    // "Cargar más": cursor = último email de p1 (uid 51).
    const last = p1.data[p1.data.length - 1];
    const cursor = `beforeDate=${encodeURIComponent(last.date)}&beforeUid=${String(last.uid)}`;
    const p2 = await page(`?limit=2&${cursor}`);
    expect(p2.data.map((e) => e.uid)).toEqual([50]); // el restante, estrictamente anterior
    expect(p2.pagination.hasMore).toBe(false);
    expect(p2.pagination.total).toBeUndefined(); // sin count en páginas con cursor (escalabilidad)

    // Sin solape entre páginas.
    const all = [...p1.data, ...p2.data].map((e) => e.uid);
    expect(new Set(all).size).toBe(3);

    // KEYSET sin huecos ante mutación: borrar uid 52 (página 1), luego "cargar más" con el MISMO
    // cursor (uid 51) sigue trayendo uid 50 — el offset no se corre (a diferencia de skip/page).
    await Email.deleteOne({ accountId: account._id, folderId: inbox._id, uid: 52 });
    const p2b = await page(`?limit=2&${cursor}`);
    expect(p2b.data.map((e) => e.uid)).toEqual([50]);

    // beforeDate sin beforeUid → 400 (refine: van juntos).
    const bad = await app.inject({
      method: 'GET',
      url: `${base}?beforeDate=${encodeURIComponent(dates.get(51) ?? '')}`,
      headers,
    });
    expect(bad.statusCode).toBe(400);
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

  it('GET /api/emails/search — $text por asunto/remitente (owner-bound; q inválida 400)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'srch@test.com' });
    const folder = await seedFolder(account._id);
    await seedEmail(account._id, folder._id, { uid: 40, subject: 'Factura de junio' });
    await seedEmail(account._id, folder._id, { uid: 41, subject: 'Reunión de equipo' });
    const headers = authHeaders(app, user._id.toString());
    const subjectsOf = (body: string) =>
      (JSON.parse(body) as { data: { subject: string }[] }).data.map((e) => e.subject);

    const res = await app.inject({ method: 'GET', url: '/api/emails/search?q=factura', headers });
    expect(res.statusCode).toBe(200);
    expect(subjectsOf(res.body)).toContain('Factura de junio');
    expect(subjectsOf(res.body)).not.toContain('Reunión de equipo');

    // Por REMITENTE: 'sender@test' (seedEmail) → tokeniza 'sender' → matchea ambos.
    const byFrom = await app.inject({ method: 'GET', url: '/api/emails/search?q=sender', headers });
    expect(subjectsOf(byFrom.body).length).toBeGreaterThanOrEqual(2);

    // $text sin tokens válidos ('.*') → 0 resultados (sin regex, sin ReDoS).
    const star = await app.inject({
      method: 'GET',
      url: `/api/emails/search?q=${encodeURIComponent('.*')}`,
      headers,
    });
    expect((JSON.parse(star.body) as { data: unknown[] }).data).toHaveLength(0);

    // q vacía/ausente → 400.
    const bad = await app.inject({ method: 'GET', url: '/api/emails/search', headers });
    expect(bad.statusCode).toBe(400);

    // Owner-bound: otro usuario no ve estos emails.
    const { user: other } = await seedUserWithAccount({ email: 'srch-other@test.com' });
    const cross = await app.inject({
      method: 'GET',
      url: '/api/emails/search?q=factura',
      headers: authHeaders(app, other._id.toString()),
    });
    expect((JSON.parse(cross.body) as { data: unknown[] }).data).toHaveLength(0);
  });

  it('GET /api/emails/search — multi-cuenta: agrega todas las cuentas del usuario sin 500 (regresión B)', async () => {
    // Regresión del HIGH (review B): con 2+ cuentas, `accountId: {$in:[...]}` sobre el índice
    // $text COMPUESTO (prefijo accountId) hacía fallar el planner (NoQueryExecutionPlans) → 500.
    // Ahora se lanza una query indexada POR cuenta y se fusiona. Aquí verificamos 200 + agregación.
    const { user, account } = await seedUserWithAccount({ email: 'multi@test.com' });
    const acc2 = await seedAccountFor(user._id, 'multi-2@test.com');
    const f1 = await seedFolder(account._id);
    const f2 = await seedFolder(acc2._id);
    await seedEmail(account._id, f1._id, { uid: 60, subject: 'Factura cuenta uno' });
    await seedEmail(acc2._id, f2._id, { uid: 61, subject: 'Factura cuenta dos' });
    const headers = authHeaders(app, user._id.toString());

    const res = await app.inject({ method: 'GET', url: '/api/emails/search?q=factura', headers });
    expect(res.statusCode).toBe(200); // antes: 500 con 2+ cuentas.
    const subjects = (JSON.parse(res.body) as { data: { subject: string }[] }).data.map(
      (e) => e.subject
    );
    // Resultado AGREGADO de ambas cuentas del usuario.
    expect(subjects).toContain('Factura cuenta uno');
    expect(subjects).toContain('Factura cuenta dos');
  });

  it('snooze: oculta de la carpeta + aparece en /snoozed; vence solo; future-only; owner-bound', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'snz@test.com' });
    const inbox = await seedFolder(account._id, { name: 'INBOX', path: 'INBOX' });
    await Folder.updateOne({ _id: inbox._id }, { specialUse: 'inbox' });
    const email = await seedEmail(account._id, inbox._id, { uid: 50, subject: 'Pendiente' });
    const headers = authHeaders(app, user._id.toString());
    const folderUrl = `/api/accounts/${account._id.toString()}/folders/${inbox._id.toString()}/emails`;
    const subjects = (body: string) =>
      (JSON.parse(body) as { data: { subject: string }[] }).data.map((e) => e.subject);

    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const snz = await app.inject({
      method: 'POST',
      url: `/api/emails/${email._id.toString()}/snooze`,
      headers,
      payload: { until },
    });
    expect(snz.statusCode).toBe(200);

    // No aparece en la carpeta; sí en /snoozed.
    const folderRes = await app.inject({ method: 'GET', url: folderUrl, headers });
    expect(subjects(folderRes.body)).not.toContain('Pendiente');
    const snoozedRes = await app.inject({ method: 'GET', url: '/api/emails/snoozed', headers });
    expect(subjects(snoozedRes.body)).toContain('Pendiente');

    // future-only: until pasado → 400.
    const past = await app.inject({
      method: 'POST',
      url: `/api/emails/${email._id.toString()}/snooze`,
      headers,
      payload: { until: new Date(Date.now() - 1000).toISOString() },
    });
    expect(past.statusCode).toBe(400);

    // Vence SOLO (sin scheduler): snoozedUntil al pasado → vuelve a la carpeta, sale de /snoozed.
    await Email.updateOne({ _id: email._id }, { snoozedUntil: new Date(Date.now() - 1000) });
    const folder2 = await app.inject({ method: 'GET', url: folderUrl, headers });
    expect(subjects(folder2.body)).toContain('Pendiente');
    const snoozed2 = await app.inject({ method: 'GET', url: '/api/emails/snoozed', headers });
    expect((JSON.parse(snoozed2.body) as { data: unknown[] }).data).toHaveLength(0);

    // Re-snooze + UNSNOOZE: vuelve a la carpeta y sale de /snoozed.
    await app.inject({
      method: 'POST',
      url: `/api/emails/${email._id.toString()}/snooze`,
      headers,
      payload: { until },
    });
    const uns = await app.inject({
      method: 'POST',
      url: `/api/emails/${email._id.toString()}/unsnooze`,
      headers,
    });
    expect(uns.statusCode).toBe(200);
    const folder3 = await app.inject({ method: 'GET', url: folderUrl, headers });
    expect(subjects(folder3.body)).toContain('Pendiente');

    // owner-bound: otro usuario no puede posponer NI ver en /snoozed este email.
    const { user: other } = await seedUserWithAccount({ email: 'snz-other@test.com' });
    const otherHeaders = authHeaders(app, other._id.toString());
    await app.inject({
      method: 'POST',
      url: `/api/emails/${email._id.toString()}/snooze`,
      headers,
      payload: { until },
    }); // re-snooze como dueño
    const cross2 = await app.inject({
      method: 'POST',
      url: `/api/emails/${email._id.toString()}/snooze`,
      headers: otherHeaders,
      payload: { until },
    });
    expect([403, 404]).toContain(cross2.statusCode);
    // owner-bound también en unsnooze: otro usuario no puede des-posponer mi email.
    const crossUns = await app.inject({
      method: 'POST',
      url: `/api/emails/${email._id.toString()}/unsnooze`,
      headers: otherHeaders,
    });
    expect([403, 404]).toContain(crossUns.statusCode);
    const otherSnoozed = await app.inject({
      method: 'GET',
      url: '/api/emails/snoozed',
      headers: otherHeaders,
    });
    expect((JSON.parse(otherSnoozed.body) as { data: unknown[] }).data).toHaveLength(0);
  });
});
