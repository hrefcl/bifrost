import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { setupTestDb, teardownTestDb, resetState } from '../../../../test/integration-helper.js';

// Se mockean SÓLO las llamadas de red de Google; el resto de oauth.ts (state, OAuthError) es real.
vi.mock('../oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../oauth.js')>();
  return {
    ...actual,
    fetchUserEmail: vi.fn(async () => 'ana@gmail.com'),
    refreshAccessToken: vi.fn(),
    revokeToken: vi.fn(async () => undefined),
  };
});

import * as oauth from '../oauth.js';
import { saveConnection, getValidAccessToken, disconnect, getStatus } from '../connection.js';
import { GoogleConnection, type IGoogleConnection } from '../../../models/GoogleConnection.js';
import { decrypt } from '../../../config/crypto.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const future = (): Date => new Date(Date.now() + 3_600_000);
const past = (): Date => new Date(Date.now() - 1_000);

describe('Google connection service (F-gcal G2)', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => {
    await resetState();
    vi.clearAllMocks();
  });

  it('saveConnection cifra los tokens y getStatus no los expone', async () => {
    const userId = new Types.ObjectId();
    await saveConnection(userId, {
      accessToken: 'access-XYZ',
      refreshToken: 'refresh-XYZ',
      expiresAt: future(),
      scope: SCOPE,
    });
    const doc = await GoogleConnection.findOne({ userId }).lean<IGoogleConnection>();
    expect(JSON.stringify(doc)).not.toContain('access-XYZ');
    expect(JSON.stringify(doc)).not.toContain('refresh-XYZ');

    const status = await getStatus(userId);
    expect(status.connected).toBe(true);
    expect(status.email).toBe('ana@gmail.com');
    expect(JSON.stringify(status)).not.toMatch(/access-XYZ|refresh-XYZ|ciphertext/);
  });

  it('getValidAccessToken devuelve el token fresco SIN refrescar', async () => {
    const userId = new Types.ObjectId();
    await saveConnection(userId, {
      accessToken: 'fresh-token',
      refreshToken: 'r',
      expiresAt: future(),
      scope: SCOPE,
    });
    expect(await getValidAccessToken(userId)).toBe('fresh-token');
    expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('token vencido → refresca y persiste el nuevo access token (cifrado)', async () => {
    const userId = new Types.ObjectId();
    await saveConnection(userId, {
      accessToken: 'old',
      refreshToken: 'r',
      expiresAt: past(),
      scope: SCOPE,
    });
    vi.mocked(oauth.refreshAccessToken).mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: future(),
      scope: SCOPE,
    });
    expect(await getValidAccessToken(userId)).toBe('new-access');
    expect(oauth.refreshAccessToken).toHaveBeenCalledOnce();
    const doc = await GoogleConnection.findOne({ userId });
    expect(decrypt(doc!.accessTokenEnc!)).toBe('new-access');
  });

  it('refresh PERMANENTE (invalid_grant) → marca la conexión en error y lanza', async () => {
    const userId = new Types.ObjectId();
    await saveConnection(userId, {
      accessToken: 'old',
      refreshToken: 'r',
      expiresAt: past(),
      scope: SCOPE,
    });
    // invalid_grant → OAuthError permanente.
    vi.mocked(oauth.refreshAccessToken).mockRejectedValue(
      new oauth.OAuthError('invalid_grant', true)
    );
    await expect(getValidAccessToken(userId)).rejects.toThrow();
    const doc = await GoogleConnection.findOne({ userId });
    expect(doc!.status).toBe('error');
  });

  it('refresh TRANSITORIO (5xx/red, no permanente) → NO desconecta, deja reintentar', async () => {
    const userId = new Types.ObjectId();
    await saveConnection(userId, {
      accessToken: 'old',
      refreshToken: 'r',
      expiresAt: past(),
      scope: SCOPE,
    });
    // Error sin `permanent` (default false) = transitorio → la conexión NO debe quedar en error.
    vi.mocked(oauth.refreshAccessToken).mockRejectedValue(
      new oauth.OAuthError('backend error 503')
    );
    await expect(getValidAccessToken(userId)).rejects.toThrow();
    const doc = await GoogleConnection.findOne({ userId });
    expect(doc!.status).toBe('connected'); // un blip no deja la conexión muerta para siempre
  });

  it('disconnect revoca en Google y borra los tokens locales (soft: queda revoked)', async () => {
    const userId = new Types.ObjectId();
    await saveConnection(userId, {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: future(),
      scope: SCOPE,
    });
    await disconnect(userId);
    expect(oauth.revokeToken).toHaveBeenCalled();
    const doc = await GoogleConnection.findOne({ userId }).lean<IGoogleConnection>();
    expect(doc?.status).toBe('revoked');
    expect(doc?.accessTokenEnc).toBeUndefined();
    expect(doc?.refreshTokenEnc).toBeUndefined();
    expect((await getStatus(userId)).connected).toBe(false);
  });
});
