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
  const savedMongo = process.env.MONGODB_URI;
  const savedRedis = process.env.REDIS_URL;
  const savedPath = process.env.SETUP_ENV_PATH;
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  };

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
    restore('ENCRYPTION_KEY', savedEnc);
    restore('JWT_SECRET', savedJwt);
    restore('MONGODB_URI', savedMongo);
    restore('REDIS_URL', savedRedis);
    restore('SETUP_ENV_PATH', savedPath);
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

  it('SEGURIDAD (review B, HIGH): tras un setup exitoso, isSetupMode→false y un 2º setup queda BLOQUEADO (no admin rogue)', async () => {
    // Estado de "deploy fresco": faltan las críticas → isSetupMode true.
    delete process.env.JWT_SECRET;
    delete process.env.MONGODB_URI;
    delete process.env.REDIS_URL;
    await fs.rm(envPath, { force: true });
    expect(isSetupMode()).toBe(true);

    const r1 = await performSetup(payload());
    expect(r1.ok).toBe(true);
    const env1 = await fs.readFile(envPath, 'utf8');
    const key1 = /ENCRYPTION_KEY=([0-9a-f]{64})/i.exec(env1)?.[1];
    expect(key1).toBeTruthy();

    // EL FIX: el setup queda cerrado en el proceso vivo SIN restart (las 4 críticas en env).
    expect(isSetupMode()).toBe(false);

    // Un 2º setup (atacante remoto con su email) → 403/'already completed', NO crea otro admin.
    const r2 = await performSetup(payload());
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/already completed/i);

    // La cuenta del 1º descifra y NO se duplicó.
    process.env.ENCRYPTION_KEY = key1;
    await mongoose.connect(server.getUri());
    const { User } = await import('../../models/User.js');
    const { Account } = await import('../../models/Account.js');
    const acc = await Account.findOne({ email: 'admin@test.com' });
    expect(acc?.getImapCredentials()).toBe('MAILBOX-PASS');
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
    expect(await Account.countDocuments({ email: 'admin@test.com' })).toBe(1);
    await mongoose.disconnect();
  });

  it('SEGURIDAD: dos performSetup CONCURRENTES → un solo admin (lock anti-race)', async () => {
    // DB limpia (sin la cuenta de los tests previos) y estado de deploy fresco.
    await mongoose.connect(server.getUri());
    const { User } = await import('../../models/User.js');
    const { Account } = await import('../../models/Account.js');
    await User.deleteMany({});
    await Account.deleteMany({});
    await mongoose.disconnect();
    delete process.env.JWT_SECRET;
    delete process.env.MONGODB_URI;
    delete process.env.REDIS_URL;
    await fs.rm(envPath, { force: true });
    expect(isSetupMode()).toBe(true);

    const one: SetupPayload = {
      ...payload(),
      admin: { email: 'one@test.com', password: 'p1pass789', displayName: 'One' },
      email: { ...payload().email, email: 'one@test.com' },
    };
    const two: SetupPayload = {
      ...payload(),
      admin: { email: 'two@test.com', password: 'p2pass789', displayName: 'Two' },
      email: { ...payload().email, email: 'two@test.com' },
    };
    const [a, b] = await Promise.all([performSetup(one), performSetup(two)]);
    // Exactamente uno completa; el otro queda bloqueado (in-progress / already completed).
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);

    process.env.ENCRYPTION_KEY = /ENCRYPTION_KEY=([0-9a-f]{64})/i.exec(
      await fs.readFile(envPath, 'utf8')
    )?.[1];
    await mongoose.connect(server.getUri());
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
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
