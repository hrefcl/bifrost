import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('../validators.js', () => ({
  validateMongoDb: () => Promise.resolve({ ok: true }),
  validateRedis: () => Promise.resolve({ ok: true }),
}));

import { performSetup, type SetupPayload } from '../setup-service.js';
import { isSetupMode } from '../../config/env.js';
import { SystemConfig } from '../../models/SystemConfig.js';

describe('performSetup idempotencia (F3.2 / H-CRYPTO-SETUP)', () => {
  let server: MongoMemoryServer;
  let envPath: string;
  const savedEnc = process.env.ENCRYPTION_KEY;
  const savedJwt = process.env.JWT_SECRET;
  const savedPath = process.env.SETUP_ENV_PATH;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    envPath = path.join(os.tmpdir(), `webmail-setup-test-${String(process.pid)}.env`);
    await fs.rm(envPath, { force: true });
    process.env.SETUP_ENV_PATH = envPath;
  });
  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await server.stop();
    await fs.rm(envPath, { force: true });
    process.env.ENCRYPTION_KEY = savedEnc;
    process.env.JWT_SECRET = savedJwt;
    if (savedPath === undefined) delete process.env.SETUP_ENV_PATH;
    else process.env.SETUP_ENV_PATH = savedPath;
  });

  const payload = (): SetupPayload => ({
    db: { mongodbUri: server.getUri(), redisUrl: 'mock' },
    admin: { email: 'admin@test.com', password: 'adminpass8', displayName: 'Admin' },
    email: {
      name: 'Admin',
      email: 'admin@test.com',
      password: 'MAILBOX-PASS',
      imapHost: 'imap.test',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.test',
      smtpPort: 465,
      smtpSecure: true,
    },
  });

  it('crea cuenta descifrable y, re-ejecutado, no rota la clave ni duplica (sin brick)', async () => {
    const r1 = await performSetup(payload());
    expect(r1.ok).toBe(true);
    const env1 = await fs.readFile(envPath, 'utf8');
    const key1 = /ENCRYPTION_KEY=([0-9a-f]{64})/i.exec(env1)?.[1];
    expect(key1).toBeTruthy();

    // Retry (simula fallo parcial + reintento): debe reusar la misma clave.
    const r2 = await performSetup(payload());
    expect(r2.ok).toBe(true);
    const env2 = await fs.readFile(envPath, 'utf8');
    const key2 = /ENCRYPTION_KEY=([0-9a-f]{64})/i.exec(env2)?.[1];
    expect(key2).toBe(key1);

    // La credencial del BUZÓN descifra con la clave persistida.
    process.env.ENCRYPTION_KEY = key2;
    await mongoose.connect(server.getUri());
    const { Account } = await import('../../models/Account.js');
    const acc = await Account.findOne({ email: 'admin@test.com' });
    expect(acc).toBeTruthy();
    expect(acc?.getImapCredentials()).toBe('MAILBOX-PASS');
    expect(await Account.countDocuments({ email: 'admin@test.com' })).toBe(1);
    await mongoose.disconnect();
  });

  it('rollback de process.env ante fallo post-.env/pre-SystemConfig; retry reusa la clave (window #3)', async () => {
    // Aislar este caso: sin secretos en process.env y con un .env temporal nuevo.
    const rbPath = path.join(os.tmpdir(), `webmail-setup-rb-${String(process.pid)}.env`);
    await fs.rm(rbPath, { force: true });
    process.env.SETUP_ENV_PATH = rbPath;
    delete process.env.JWT_SECRET;
    delete process.env.ENCRYPTION_KEY;

    // Forzar fallo justo después de writeEnvFile (SystemConfig lanza una vez).
    const spy = vi
      .spyOn(SystemConfig, 'findOneAndUpdate')
      .mockRejectedValueOnce(new Error('boom') as never);

    await expect(performSetup(payload())).rejects.toThrow();

    // Rollback: los secretos volvieron a ausentes en RAM → isSetupMode sigue true.
    expect(process.env.JWT_SECRET).toBeUndefined();
    expect(process.env.ENCRYPTION_KEY).toBeUndefined();
    expect(isSetupMode()).toBe(true);

    // Pero el .env YA tiene la clave (writeEnvFile corrió antes del fallo).
    const envAfterFail = await fs.readFile(rbPath, 'utf8');
    const keyAfterFail = /ENCRYPTION_KEY=([0-9a-f]{64})/i.exec(envAfterFail)?.[1];
    expect(keyAfterFail).toBeTruthy();

    // Retry (sin el fallo): reusa la MISMA clave del .env (no rota) y completa.
    spy.mockRestore();
    const retry = await performSetup(payload());
    expect(retry.ok).toBe(true);
    const envAfterRetry = await fs.readFile(rbPath, 'utf8');
    const keyAfterRetry = /ENCRYPTION_KEY=([0-9a-f]{64})/i.exec(envAfterRetry)?.[1];
    expect(keyAfterRetry).toBe(keyAfterFail);

    // La cuenta descifra con esa clave.
    process.env.ENCRYPTION_KEY = keyAfterRetry;
    await mongoose.connect(server.getUri());
    const { Account } = await import('../../models/Account.js');
    const acc = await Account.findOne({ email: 'admin@test.com' });
    expect(acc?.getImapCredentials()).toBe('MAILBOX-PASS');
    await mongoose.disconnect();
    await fs.rm(rbPath, { force: true });
  });
});
