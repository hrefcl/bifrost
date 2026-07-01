import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('livekit-server-sdk', () => {
  class AccessToken {
    constructor(
      public key?: string,
      public secret?: string,
      _o?: unknown
    ) {}
    addGrant(_g: unknown): void {}
    async toJwt(): Promise<string> {
      return `tok:${this.key}:${this.secret}`; // refleja las creds usadas (para asertar la fuente)
    }
  }
  class RoomServiceClient {
    constructor(_h: string, _k?: string, _s?: string) {}
    async createRoom(_o: unknown): Promise<unknown> {
      return {};
    }
    async deleteRoom(_n: string): Promise<void> {}
  }
  return { AccessToken, RoomServiceClient };
});

import { encrypt } from '../../../config/crypto.js';
import {
  resolveLivekitCreds,
  meetEnabled,
  livekitSourceOf,
  issueAccessToken,
  LivekitCredsError,
} from '../token-service.js';
import type { StoredMeetSettings } from '../settings.js';

const BASE: StoredMeetSettings = {
  enabled: true,
  wsUrl: 'wss://meet.test',
  publicBaseUrl: 'https://webmail.test',
  maxParticipants: 20,
  maxDurationMinutes: 240,
  allowExternal: true,
  auditEnabled: true,
};

describe('resolveLivekitCreds — DB-XOR-env atómico (F3.7)', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_API_URL;
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('par DB completo → source db (decrypt) + apiUrl de DB o derivado', () => {
    const s: StoredMeetSettings = {
      ...BASE,
      livekitApiKey: 'DBKEY',
      livekitApiSecretEnc: encrypt('dbsecret'),
      livekitApiUrl: 'https://x.livekit.cloud',
    };
    const r = resolveLivekitCreds(s);
    expect(r).toEqual({
      source: 'db',
      key: 'DBKEY',
      secret: 'dbsecret',
      apiUrl: 'https://x.livekit.cloud',
    });
  });

  it('par DB completo SIN apiUrl → deriva de wsUrl (wss→https)', () => {
    const r = resolveLivekitCreds({
      ...BASE,
      livekitApiKey: 'K',
      livekitApiSecretEnc: encrypt('s'),
    });
    expect(r).toMatchObject({ source: 'db', apiUrl: 'https://meet.test' });
  });

  it('par DB AUSENTE + env presente → source env (NUNCA mezcla)', () => {
    process.env.LIVEKIT_API_KEY = 'ENVKEY';
    process.env.LIVEKIT_API_SECRET = 'envsecret';
    process.env.LIVEKIT_API_URL = 'http://livekit:7880';
    const r = resolveLivekitCreds(BASE);
    expect(r).toEqual({
      source: 'env',
      key: 'ENVKEY',
      secret: 'envsecret',
      apiUrl: 'http://livekit:7880',
    });
  });

  it('par DB PARCIAL (solo key) → se trata como ausente → env (review C-R1)', () => {
    process.env.LIVEKIT_API_KEY = 'ENVKEY';
    process.env.LIVEKIT_API_SECRET = 'envsecret';
    const r = resolveLivekitCreds({ ...BASE, livekitApiKey: 'DBKEY' }); // sin secretEnc
    expect(r.source).toBe('env');
  });

  it('par DB presente pero INDESENCRIPTABLE (key rotada) → source error, NO alias a env (review C-M2)', () => {
    process.env.LIVEKIT_API_KEY = 'ENVKEY';
    process.env.LIVEKIT_API_SECRET = 'envsecret';
    // EncryptedPayload con tag/ciphertext basura → decrypt() lanza (GCM no verifica).
    const corrupt = { ...encrypt('x'), tag: '00000000000000000000000000000000' };
    const r = resolveLivekitCreds({
      ...BASE,
      livekitApiKey: 'DBKEY',
      livekitApiSecretEnc: corrupt,
    });
    expect(r).toEqual({ source: 'error' });
  });

  it('sin creds en ningún lado → source none', () => {
    expect(resolveLivekitCreds(BASE)).toEqual({ source: 'none' });
  });
});

describe('meetEnabled — presencia, total, nunca lanza (F3.7 C-M2)', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('false si no enabled / sin wsUrl / sin publicBaseUrl / sin creds', () => {
    expect(meetEnabled({ ...BASE, enabled: false })).toBe(false);
    expect(meetEnabled({ ...BASE, wsUrl: '' })).toBe(false);
    expect(meetEnabled({ ...BASE, publicBaseUrl: '' })).toBe(false);
    expect(meetEnabled(BASE)).toBe(false); // sin creds
  });

  it('true con par DB presente (NO desencripta — boolean explícito)', () => {
    const v = meetEnabled({ ...BASE, livekitApiKey: 'K', livekitApiSecretEnc: encrypt('s') });
    expect(v).toBe(true);
  });

  it('true con env presente (backward-compat)', () => {
    process.env.LIVEKIT_API_KEY = 'K';
    process.env.LIVEKIT_API_SECRET = 'S';
    expect(meetEnabled(BASE)).toBe(true);
  });

  it('NO lanza con secret indesencriptable (presencia true; el fail-closed es al emitir token)', () => {
    const corrupt = { ...encrypt('x'), tag: '00000000000000000000000000000000' };
    expect(() =>
      meetEnabled({ ...BASE, livekitApiKey: 'K', livekitApiSecretEnc: corrupt })
    ).not.toThrow();
    expect(meetEnabled({ ...BASE, livekitApiKey: 'K', livekitApiSecretEnc: corrupt })).toBe(true);
  });
});

describe('livekitSourceOf + issueAccessToken fail-closed', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('livekitSourceOf refleja la fuente efectiva', () => {
    expect(livekitSourceOf(BASE)).toBe('none');
    expect(
      livekitSourceOf({ ...BASE, livekitApiKey: 'K', livekitApiSecretEnc: encrypt('s') })
    ).toBe('db');
  });

  it('issueAccessToken usa las creds DB (no env) cuando ambas existen', async () => {
    process.env.LIVEKIT_API_KEY = 'ENVKEY';
    process.env.LIVEKIT_API_SECRET = 'envsecret';
    const s: StoredMeetSettings = {
      ...BASE,
      livekitApiKey: 'DBKEY',
      livekitApiSecretEnc: encrypt('dbsecret'),
    };
    const tok = await issueAccessToken({
      settings: s,
      role: 'external',
      slug: 'slug123',
      identity: 'guest-1',
      displayName: 'X',
      ttlSeconds: 60,
    });
    expect(tok).toBe('tok:DBKEY:dbsecret'); // ← DB, no env
  });

  it('issueAccessToken LANZA LivekitCredsError si no hay creds usables (fail-closed)', async () => {
    await expect(
      issueAccessToken({
        settings: BASE,
        role: 'external',
        slug: 'slug123',
        identity: 'g',
        displayName: 'X',
        ttlSeconds: 60,
      })
    ).rejects.toBeInstanceOf(LivekitCredsError);
  });
});
