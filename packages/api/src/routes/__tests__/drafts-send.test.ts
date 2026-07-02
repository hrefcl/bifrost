import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const h = vi.hoisted(() => ({ sent: 0, appended: 0, lastRaw: '' }));
// Espía para asertar la regresión del fix de Enviados (el send debe SINCRONIZAR el folder Sent).
const imapMock = vi.hoisted(() => ({ syncFolderHeaders: vi.fn(() => Promise.resolve(0)) }));

vi.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: (opts: { raw?: Buffer | string }) => {
      h.sent++;
      h.lastRaw = opts.raw?.toString() ?? '';
      return Promise.resolve({ messageId: '<smtp@test>' });
    },
    close: () => undefined,
  }),
}));

vi.mock('imapflow', () => {
  class ImapFlow {
    constructor(_o: unknown) {}
    connect(): Promise<void> {
      return Promise.resolve();
    }
    logout(): Promise<void> {
      return Promise.resolve();
    }
    append(): Promise<void> {
      h.appended++;
      return Promise.resolve();
    }
  }
  return { ImapFlow };
});

// Mock PARCIAL de imap.js: `appendToSent` queda REAL (usa el ImapFlow mockeado → cuenta h.appended),
// pero `syncFolderHeaders` se espía para asertar que el send sincroniza el folder Sent tras el APPEND
// (regresión del bug "el enviado no aparecía en Enviados"). El fake IMAP no ejercita el sync real.
vi.mock('../../services/imap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/imap.js')>();
  return { ...actual, syncFolderHeaders: imapMock.syncFolderHeaders };
});

import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { Draft } from '../../models/Draft.js';
import { Folder } from '../../models/Folder.js';
import { User } from '../../models/User.js';
import { Contact } from '../../models/Contact.js';
import { recoverStuckDrafts } from '../drafts.js';
import { redis } from '../../config/redis.js';

describe('envío de drafts (F3.5)', () => {
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
    h.sent = 0;
    h.appended = 0;
    h.lastRaw = '';
    imapMock.syncFolderHeaders.mockClear();
  });

  async function makeDraft(userId: string, accountId: string, to = [{ address: 'dest@test.com' }]) {
    return Draft.create({
      userId,
      accountId,
      to,
      subject: 'Hola',
      bodyText: 'cuerpo',
      status: 'editing',
      lastModifiedAt: new Date(),
    });
  }

  it('envía, marca sent con sentMessageId y copia a Sent', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const draft = await makeDraft(user._id.toString(), account._id.toString());
    const res = await app.inject({
      method: 'POST',
      url: `/api/drafts/${draft._id.toString()}/send`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    expect(h.sent).toBe(1);
    expect(h.appended).toBe(1); // copia a Sent
    const after = await Draft.findById(draft._id);
    expect(after?.status).toBe('sent');
    expect(after?.sentMessageId).toBeTruthy();
    expect(after?.sentAt).toBeTruthy();
  });

  it('tras enviar, SINCRONIZA el folder Sent (regresión: el enviado debe aparecer en Enviados)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    // El APPEND deja el mensaje en IMAP Sent, pero la vista Enviados lee de Mongo → el handler debe
    // sincronizar el folder Sent para que aparezca. Bug histórico: no lo hacía (quedaba sólo en IMAP).
    const sent = await Folder.create({
      accountId: account._id,
      name: 'Sent',
      path: 'Sent',
      displayName: 'Sent',
      specialUse: 'sent',
      uidValidity: 1,
      uidNext: 1,
    });
    const draft = await makeDraft(user._id.toString(), account._id.toString());
    const res = await app.inject({
      method: 'POST',
      url: `/api/drafts/${draft._id.toString()}/send`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    expect(h.appended).toBe(1); // copió a IMAP Sent
    // ...y sincronizó ESE folder Sent para reflejarlo en Mongo (lo que faltaba y causaba el bug).
    expect(imapMock.syncFolderHeaders).toHaveBeenCalledTimes(1);
    expect(imapMock.syncFolderHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ _id: account._id }),
      sent._id.toString()
    );
  });

  it('rate-limit por buzón: excede el cap → 429 + Retry-After, NO envía y revierte a editing', async () => {
    await redis.flushall();
    process.env.OUTBOUND_MAX_RCPT_PER_MIN = '1'; // cap minúsculo para el test
    try {
      const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
      // 2 destinatarios > cap de 1 → debe bloquear en el primer envío.
      const draft = await makeDraft(user._id.toString(), account._id.toString(), [
        { address: 'a@test.com' },
        { address: 'b@test.com' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: `/api/drafts/${draft._id.toString()}/send`,
        headers: authHeaders(app, user._id.toString()),
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeTruthy();
      expect(h.sent).toBe(0); // NO se hizo submit SMTP
      // El draft se revierte a 'editing' (se reclamó a 'sending') para que el user pueda reintentar.
      const after = await Draft.findById(draft._id);
      expect(after?.status).toBe('editing');
    } finally {
      delete process.env.OUTBOUND_MAX_RCPT_PER_MIN;
      await redis.flushall();
    }
  });

  it('cap de destinatarios por MENSAJE: excede → 400, NO envía y revierte a editing', async () => {
    await redis.flushall();
    process.env.OUTBOUND_MAX_RCPT_PER_MESSAGE = '2';
    try {
      const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
      const draft = await makeDraft(user._id.toString(), account._id.toString(), [
        { address: 'a@test.com' },
        { address: 'b@test.com' },
        { address: 'c@test.com' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: `/api/drafts/${draft._id.toString()}/send`,
        headers: authHeaders(app, user._id.toString()),
      });
      expect(res.statusCode).toBe(400);
      expect(h.sent).toBe(0);
      const after = await Draft.findById(draft._id);
      expect(after?.status).toBe('editing');
    } finally {
      delete process.env.OUTBOUND_MAX_RCPT_PER_MESSAGE;
    }
  });

  it('reenviar un draft ya enviado es idempotente (no re-envía)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const draft = await makeDraft(user._id.toString(), account._id.toString());
    const url = `/api/drafts/${draft._id.toString()}/send`;
    const hdr = authHeaders(app, user._id.toString());
    await app.inject({ method: 'POST', url, headers: hdr });
    const res2 = await app.inject({ method: 'POST', url, headers: hdr });
    expect(res2.statusCode).toBe(200);
    expect((JSON.parse(res2.body) as { alreadySent?: boolean }).alreadySent).toBe(true);
    expect(h.sent).toBe(1); // NO se reenvió
  });

  it('dos /send concurrentes → un solo envío (transición atómica)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const draft = await makeDraft(user._id.toString(), account._id.toString());
    const url = `/api/drafts/${draft._id.toString()}/send`;
    const hdr = authHeaders(app, user._id.toString());
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url, headers: hdr }),
      app.inject({ method: 'POST', url, headers: hdr }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    // Invariante real: EXACTAMENTE un envío SMTP (sin doble-envío). Los status válidos son
    // [200,409] (concurrente: el 2º choca con 'sending') o [200,200] (serializado: el 2º
    // llegó tras completar → idempotente). Asertar [200,409] exacto era flaky (depende del
    // interleaving). Lo que NUNCA debe pasar: dos envíos, o dos errores.
    expect(h.sent).toBe(1);
    expect(codes).toContain(200);
    expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
  });

  it('draft en failed + dos /send concurrentes → un solo claim (atómico)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const draft = await Draft.create({
      userId: user._id,
      accountId: account._id,
      to: [{ address: 'x@test.com' }],
      subject: 's',
      bodyText: 'b',
      status: 'failed',
      lastModifiedAt: new Date(),
    });
    const url = `/api/drafts/${draft._id.toString()}/send`;
    const hdr = authHeaders(app, user._id.toString());
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url, headers: hdr }),
      app.inject({ method: 'POST', url, headers: hdr }),
    ]);
    // Invariante real: EXACTAMENTE un envío SMTP (claim atómico). Los status válidos son
    // [200,409] (concurrente: el 2º choca con 'sending') o [200,200] (serializado: el 2º llegó
    // tras completar → idempotente alreadySent). Asertar [200,409] exacto era FLAKY (depende del
    // interleaving) — el double-run de CI lo destapó. Lo que NUNCA debe pasar: dos envíos.
    const codes = [a.statusCode, b.statusCode].sort();
    expect(h.sent).toBe(1);
    expect(codes).toContain(200);
    expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
  });

  it('draft sin destinatarios → 400 y vuelve a editing', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const draft = await makeDraft(user._id.toString(), account._id.toString(), []);
    const res = await app.inject({
      method: 'POST',
      url: `/api/drafts/${draft._id.toString()}/send`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(400);
    expect(h.sent).toBe(0);
    const after = await Draft.findById(draft._id);
    expect(after?.status).toBe('editing');
  });

  it('PATCH de un draft en sending → 409 (no reabre doble envío)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const draft = await Draft.create({
      userId: user._id,
      accountId: account._id,
      to: [{ address: 'x@test.com' }],
      subject: 's',
      status: 'sending',
      sendingSince: new Date(),
      sentMessageId: '<keep@test>',
      lastModifiedAt: new Date(),
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/drafts/${draft._id.toString()}`,
      headers: authHeaders(app, user._id.toString()),
      payload: { subject: 'hack' },
    });
    expect(res.statusCode).toBe(409);
    const after = await Draft.findById(draft._id);
    expect(after?.status).toBe('sending'); // intacto
    expect(after?.sentMessageId).toBe('<keep@test>');
  });

  it('PATCH de un draft sent → 409 (terminal; el GC limpia sus adjuntos, no se reabre)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const draft = await Draft.create({
      userId: user._id,
      accountId: account._id,
      to: [{ address: 'x@test.com' }],
      subject: 's',
      status: 'sent',
      sentMessageId: '<sent@test>',
      sentAt: new Date(),
      lastModifiedAt: new Date(),
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/drafts/${draft._id.toString()}`,
      headers: authHeaders(app, user._id.toString()),
      payload: { subject: 'reopen' },
    });
    expect(res.statusCode).toBe(409);
    const after = await Draft.findById(draft._id);
    expect(after?.status).toBe('sent'); // intacto, no reabierto
    expect(after?.subject).toBe('s');
  });

  it('el raw enviado/copiado a Sent NO contiene cabecera/dirección Bcc', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const draft = await Draft.create({
      userId: user._id,
      accountId: account._id,
      to: [{ address: 'to@test.com' }],
      bcc: [{ address: 'secret-bcc@test.com' }],
      subject: 's',
      bodyText: 'b',
      status: 'editing',
      lastModifiedAt: new Date(),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/drafts/${draft._id.toString()}/send`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    expect(h.lastRaw).not.toMatch(/Bcc:/i);
    expect(h.lastRaw).not.toContain('secret-bcc@test.com');
  });

  it('DELETE de un draft en sending → 409 (no deja envío sin registro)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const draft = await Draft.create({
      userId: user._id,
      accountId: account._id,
      to: [{ address: 'x@test.com' }],
      subject: 's',
      status: 'sending',
      sendingSince: new Date(),
      lastModifiedAt: new Date(),
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/drafts/${draft._id.toString()}`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(409);
    expect(await Draft.findById(draft._id)).not.toBeNull();
  });

  it('recoverStuckDrafts revierte sending viejos a failed', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'me@test.com' });
    const draft = await Draft.create({
      userId: user._id,
      accountId: account._id,
      to: [{ address: 'x@test.com' }],
      subject: 's',
      status: 'sending',
      sendingSince: new Date(Date.now() - 10 * 60 * 1000), // 10 min atrás
      lastModifiedAt: new Date(),
    });
    const n = await recoverStuckDrafts(5 * 60 * 1000);
    expect(n).toBe(1);
    const after = await Draft.findById(draft._id);
    expect(after?.status).toBe('failed');
  });

  it('firma: se añade SERVER-SIDE al enviar con separador "-- " (no en el draft)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'firma@test.com' });
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          'preferences.autoIncludeSignature': true,
          'preferences.defaultSignature': '<table><tr><td>Saludos, ACME</td></tr></table>',
        },
      }
    );
    const draft = await makeDraft(user._id.toString(), account._id.toString());
    const res = await app.inject({
      method: 'POST',
      url: `/api/drafts/${draft._id.toString()}/send`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    // El RAW enviado lleva la firma (tabla preservada por el sanitizador) + el separador.
    expect(h.lastRaw).toContain('Saludos, ACME');
    expect(h.lastRaw).toMatch(/--/);
    // El draft persistido NO se contamina con la firma (se agrega sólo en el envío).
    const persisted = await Draft.findById(draft._id);
    expect(persisted?.bodyHtml ?? '').not.toContain('Saludos, ACME');
  });

  it('auto-guarda al destinatario como contacto al enviar (estilo Gmail)', async () => {
    const { user, account } = await seedUserWithAccount({ email: 'sender@test.com' });
    const draft = await makeDraft(user._id.toString(), account._id.toString(), [
      { name: 'Cliente Uno', address: 'cliente1@externo.com' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/drafts/${draft._id.toString()}/send`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    const contact = await Contact.findOne({ userId: user._id, email: 'cliente1@externo.com' });
    expect(contact).not.toBeNull();
    expect(contact?.fullName).toBe('Cliente Uno');
    expect(contact?.source).toBe('auto');
  });
});
