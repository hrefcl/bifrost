import { describe, it, expect } from 'vitest';
import { buildAuthUrl, consumeState, OAuthError, GOOGLE_SCOPE } from '../oauth.js';

/** Extrae el parámetro `state` de una authUrl. */
function stateOf(url: string): string {
  const s = new URL(url).searchParams.get('state');
  if (!s) throw new Error('sin state');
  return s;
}

describe('Google OAuth: state + PKCE (F-gcal G2)', () => {
  it('authUrl pide scope MÍNIMO + PKCE S256 + offline/consent', async () => {
    const params = new URL(await buildAuthUrl('u1')).searchParams;
    expect(params.get('scope')).toBe(GOOGLE_SCOPE); // sólo calendar.events
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBeTruthy();
    expect(params.get('access_type')).toBe('offline'); // → refresh token
    expect(params.get('prompt')).toBe('consent');
    expect(params.get('state')).toBeTruthy();
  });

  it('un state válido se consume UNA sola vez (single-use) y trae el userId firmado', async () => {
    const state = stateOf(await buildAuthUrl('user-abc'));
    const first = await consumeState(state);
    expect(first.userId).toBe('user-abc');
    expect(first.verifier).toBeTruthy();
    // Segundo intento con el mismo state → rechazado (replay imposible).
    await expect(consumeState(state)).rejects.toThrow(OAuthError);
  });

  it('un state con HMAC alterado se rechaza (no manipulable)', async () => {
    const state = stateOf(await buildAuthUrl('user-x'));
    const [nonce, uid, ts] = Buffer.from(state, 'base64url').toString('utf8').split(':');
    const tampered = Buffer.from(`${nonce}:${uid}:${ts}:forgedmac`).toString('base64url');
    await expect(consumeState(tampered)).rejects.toThrow(/manipulado/);
  });

  it('un state forjado para otro usuario (sin la clave HMAC) se rechaza', async () => {
    // Un atacante NO puede fabricar un state válido para la víctima sin conocer JWT_SECRET.
    const forged = Buffer.from(`nonce:victima:${Date.now()}:deadbeef`).toString('base64url');
    await expect(consumeState(forged)).rejects.toThrow(OAuthError);
  });
});
