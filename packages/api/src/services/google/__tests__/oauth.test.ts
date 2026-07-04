import { describe, it, expect, vi } from 'vitest';

// Este test es unit puro (state/PKCE, sin DB): se mockean las creds para que buildAuthUrl no pegue a Mongo.
vi.mock('../creds.js', () => ({
  resolveGoogleCreds: async () => ({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    redirectUri: 'https://example.com/api/calendar/google/callback',
  }),
  googleCredsStatus: async () => ({
    source: 'env',
    clientId: 'test-client',
    redirectUri: 'https://example.com/api/calendar/google/callback',
  }),
  googleEnabled: async () => true,
}));

import { buildAuthUrl, consumeState, OAuthError, GOOGLE_SCOPE } from '../oauth.js';

/** Extrae el parámetro `state` de una authUrl. */
function stateOf(url: string): string {
  const s = new URL(url).searchParams.get('state');
  if (!s) throw new Error('sin state');
  return s;
}

describe('Google OAuth: state + PKCE (F-gcal G2)', () => {
  it('authUrl pide scope MÍNIMO + PKCE S256 + offline/consent', async () => {
    const { url } = await buildAuthUrl('u1');
    const params = new URL(url).searchParams;
    expect(params.get('scope')).toBe(GOOGLE_SCOPE); // openid email + calendar.events (mínimo funcional)
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBeTruthy();
    expect(params.get('access_type')).toBe('offline'); // → refresh token
    expect(params.get('prompt')).toBe('consent');
    expect(params.get('state')).toBeTruthy();
  });

  it('un state válido (con su cookie) se consume UNA sola vez y trae el userId firmado', async () => {
    const { url, nonce } = await buildAuthUrl('user-abc');
    const state = stateOf(url);
    const first = await consumeState(state, nonce);
    expect(first.userId).toBe('user-abc');
    expect(first.verifier).toBeTruthy();
    // Segundo intento con el mismo state → rechazado (replay imposible).
    await expect(consumeState(state, nonce)).rejects.toThrow(OAuthError);
  });

  it('anti-CSRF: state válido pero cookie que NO coincide → rechazado', async () => {
    const { url } = await buildAuthUrl('user-csrf');
    const state = stateOf(url);
    // Simula el flujo del atacante completado en el navegador de la víctima (cookie ausente o distinta).
    await expect(consumeState(state, undefined)).rejects.toThrow(/navegador/);
    await expect(consumeState(state, 'otro-nonce')).rejects.toThrow(/navegador/);
  });

  it('un state con HMAC alterado se rechaza (no manipulable)', async () => {
    const { url, nonce } = await buildAuthUrl('user-x');
    const state = stateOf(url);
    const [n, uid, ts] = Buffer.from(state, 'base64url').toString('utf8').split(':');
    const tampered = Buffer.from(`${n}:${uid}:${ts}:forgedmac`).toString('base64url');
    await expect(consumeState(tampered, nonce)).rejects.toThrow(/manipulado/);
  });

  it('un state forjado para otro usuario (sin la clave HMAC) se rechaza', async () => {
    // Un atacante NO puede fabricar un state válido para la víctima sin conocer JWT_SECRET.
    const forged = Buffer.from(`nonce:victima:${Date.now()}:deadbeef`).toString('base64url');
    await expect(consumeState(forged, 'nonce')).rejects.toThrow(OAuthError);
  });
});
