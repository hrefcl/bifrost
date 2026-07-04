import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, resetState } from '../../../../test/integration-helper.js';
import { env } from '../../../config/env.js';
import { SystemConfig } from '../../../models/SystemConfig.js';
import { setGoogleConfig } from '../settings.js';
import {
  googleEnabled,
  googleCredsStatus,
  resolveGoogleCreds,
  invalidateGoogleCredsCache,
} from '../creds.js';

function clearEnv(): void {
  env.GOOGLE_CLIENT_ID = undefined;
  env.GOOGLE_CLIENT_SECRET = undefined;
  env.GOOGLE_REDIRECT_URI = undefined;
}
function setEnv(): void {
  env.GOOGLE_CLIENT_ID = 'env-id';
  env.GOOGLE_CLIENT_SECRET = 'env-secret';
  env.GOOGLE_REDIRECT_URI = 'https://env.example/cb';
}

describe('resolveGoogleCreds / googleEnabled — DB-o-env, fail-closed (F-gcal admin-config)', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => {
    clearEnv();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
    invalidateGoogleCredsCache();
    clearEnv();
  });

  it('sin DB ni env → source none, deshabilitado, resolve LANZA', async () => {
    expect(await googleEnabled()).toBe(false);
    expect((await googleCredsStatus()).source).toBe('none');
    await expect(resolveGoogleCreds()).rejects.toThrow();
  });

  it('sólo env (trío completo) → source env, habilitado', async () => {
    setEnv();
    invalidateGoogleCredsCache();
    expect(await googleEnabled()).toBe(true);
    expect((await googleCredsStatus()).source).toBe('env');
    expect(await resolveGoogleCreds()).toEqual({
      clientId: 'env-id',
      clientSecret: 'env-secret',
      redirectUri: 'https://env.example/cb',
    });
  });

  it('DB (trío completo) → source db, secret DESCIFRADO; DB MANDA sobre env', async () => {
    setEnv(); // aunque haya env, la DB completa gana
    await setGoogleConfig({
      clientId: 'db-id',
      redirectUri: 'https://db.example/cb',
      clientSecret: 'db-secret',
    });
    invalidateGoogleCredsCache();
    expect((await googleCredsStatus()).source).toBe('db');
    expect(await resolveGoogleCreds()).toEqual({
      clientId: 'db-id',
      clientSecret: 'db-secret',
      redirectUri: 'https://db.example/cb',
    });
  });

  it('DB PARCIAL (falta redirectUri) → NO usa DB; cae a env (o none)', async () => {
    await setGoogleConfig({ clientId: 'db-id', clientSecret: 'db-secret' }); // sin redirectUri
    invalidateGoogleCredsCache();
    expect((await googleCredsStatus()).source).toBe('none'); // parcial no activa DB, sin env → none
    setEnv();
    invalidateGoogleCredsCache();
    expect((await googleCredsStatus()).source).toBe('env'); // cae a env, sin mezclar con el DB parcial
  });

  it('DB con secret INDESCIFRABLE (trío completo) → source error, deshabilitado (fail-closed), NO cae a env', async () => {
    await SystemConfig.findOneAndUpdate(
      { key: 'googleCalendar' },
      {
        $set: {
          value: {
            clientId: 'x',
            redirectUri: 'https://x.example/cb',
            clientSecretEnc: { ciphertext: 'bad', iv: 'bad', tag: 'bad' },
          },
        },
      },
      { upsert: true }
    );
    setEnv(); // aunque haya env, un trío DB completo que no descifra NO debe aliasar a env
    invalidateGoogleCredsCache();
    expect((await googleCredsStatus()).source).toBe('error');
    expect(await googleEnabled()).toBe(false); // fail-closed
    await expect(resolveGoogleCreds()).rejects.toThrow();
  });

  it('cache: un cambio de config no se ve hasta invalidar', async () => {
    setEnv();
    invalidateGoogleCredsCache();
    expect(await googleEnabled()).toBe(true); // pobla cache (env)
    clearEnv(); // cambia el env pero NO invalido
    expect(await googleEnabled()).toBe(true); // sigue cacheado
    invalidateGoogleCredsCache();
    expect(await googleEnabled()).toBe(false); // ahora refleja el cambio
  });
});
