import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const h = vi.hoisted(() => ({ sent: 0, appended: 0, lastRaw: '' }));

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

import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { Draft } from '../../models/Draft.js';
import { recoverStuckDrafts } from '../drafts.js';

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
});
