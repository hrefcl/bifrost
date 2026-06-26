import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import {
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  getUserIdFromRefreshToken,
} from '../auth.js';
import { redis, closeRedis } from '../../config/redis.js';

describe('rotación de refresh token (F3.6 / H-AUTH-ROT)', () => {
  beforeEach(async () => {
    await redis.flushall();
  });
  afterAll(async () => {
    await closeRedis();
  });

  it('rota: el viejo se consume, el nuevo sirve, y el reuse revoca la familia', async () => {
    const t1 = await createRefreshToken('user1', 'fam1');
    expect(getUserIdFromRefreshToken(t1)).toBe('user1');

    const r = await rotateRefreshToken(t1);
    expect(r?.userId).toBe('user1');
    expect(r?.token).not.toBe(t1);

    // Reusar el viejo (ya consumido) → null + revoca la familia entera.
    expect(await rotateRefreshToken(t1)).toBeNull();
    // Por la revocación, el token nuevo tampoco sirve (respuesta correcta ante robo).
    expect(await rotateRefreshToken(r?.token ?? '')).toBeNull();
  });

  it('rotaciones concurrentes del mismo token → exactamente una gana (GETDEL atómico)', async () => {
    const t = await createRefreshToken('u', 'f');
    const [a, b] = await Promise.all([rotateRefreshToken(t), rotateRefreshToken(t)]);
    const wins = [a, b].filter((x) => x !== null);
    expect(wins.length).toBe(1);
  });

  it('revokeRefreshToken invalida toda la familia', async () => {
    const t = await createRefreshToken('u2', 'fam2');
    await revokeRefreshToken(t);
    expect(await rotateRefreshToken(t)).toBeNull();
  });

  it('token malformado → userId null y rotate null (sin redis.keys)', async () => {
    expect(getUserIdFromRefreshToken('garbage')).toBeNull();
    expect(getUserIdFromRefreshToken('a.b')).toBeNull();
    expect(await rotateRefreshToken('a.b')).toBeNull();
  });

  it('token forjado (HMAC inválido) → rechazado SIN revocar la familia (anti-DoS)', async () => {
    const real = await createRefreshToken('victim', 'famX');
    // Atacante conoce userId/familyId pero NO puede firmar el envelope.
    const forged = 'victim.famX.deadbeefdeadbeef.badmac';
    expect(getUserIdFromRefreshToken(forged)).toBeNull(); // HMAC inválido
    expect(await rotateRefreshToken(forged)).toBeNull();
    // MAC de 64 chars Unicode no-ASCII no debe lanzar (→ null, no 500).
    expect(await rotateRefreshToken(`u.f.r.${'é'.repeat(64)}`)).toBeNull();
    // La familia de la víctima NO fue revocada: su token real sigue rotando.
    expect(await rotateRefreshToken(real)).not.toBeNull();
  });
});
