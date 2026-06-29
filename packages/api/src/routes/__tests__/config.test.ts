import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
} from '../../../test/integration-helper.js';

describe('GET /api/config/mail-server', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });
  afterEach(() => {
    delete process.env.MAIL_SERVER_HOST;
  });

  it('sin MAIL_SERVER_HOST → mailServer null (instalación genérica, config manual visible)', async () => {
    delete process.env.MAIL_SERVER_HOST;
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/config/mail-server' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mailServer: null });
    await app.close();
  });

  it('con MAIL_SERVER_HOST → defaults del mailserver propio (IMAPS 993 + SMTPS 465 TLS)', async () => {
    process.env.MAIL_SERVER_HOST = 'mail.aulion.app';
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/config/mail-server' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      mailServer: {
        imapHost: 'mail.aulion.app',
        imapPort: 993,
        imapSecure: true,
        smtpHost: 'mail.aulion.app',
        smtpPort: 465,
        smtpSecure: true,
      },
    });
    await app.close();
  });

  it('es público (sin auth)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/config/mail-server' });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });
});
