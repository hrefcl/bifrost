import { describe, it, expect } from 'vitest';
import {
  buildGrants,
  makeOpaqueIdentity,
  clampMaxParticipants,
  authorizeAndComputeTtl,
  EARLY_JOIN_MS,
  GRACE_MS,
  type MeetRole,
} from '../token-service.js';
import type { MeetSettings } from '@webmail6/shared';

const SETTINGS: MeetSettings = {
  enabled: true,
  wsUrl: 'wss://meet.test',
  publicBaseUrl: 'https://webmail.test',
  maxParticipants: 20,
  maxDurationMinutes: 240, // 4h cap
  allowExternal: true,
  auditEnabled: true,
  recordingPolicy: 'disabled',
  hasApiSecret: false,
  livekitSource: 'env',
};

describe('buildGrants — matriz de permisos por rol', () => {
  it('host: roomJoin + roomAdmin + publish/subscribe/data + roomCreate, room=slug', () => {
    const g = buildGrants('host', 'abc');
    expect(g).toMatchObject({
      room: 'abc',
      roomJoin: true,
      roomCreate: true,
      roomAdmin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
  });

  it('interno y externo: SIN roomAdmin (sólo el host modera)', () => {
    for (const role of ['internal', 'external'] as MeetRole[]) {
      const g = buildGrants(role, 'abc');
      expect(g.roomAdmin).toBeUndefined();
      expect(g.roomJoin).toBe(true);
      expect(g.canPublish).toBe(true); // habilita cámara/mic/PANTALLA (screen share en MVP)
    }
  });

  it('NUNCA otorga roomList ni roomRecord a ningún rol', () => {
    for (const role of ['host', 'internal', 'external'] as MeetRole[]) {
      const g = buildGrants(role, 'abc');
      expect(g.roomList).toBeUndefined();
      expect(g.roomRecord).toBeUndefined();
    }
  });
});

describe('makeOpaqueIdentity — identidad opaca y única', () => {
  it('prefijo por rol, no derivada del nombre, y única entre llamadas', () => {
    expect(makeOpaqueIdentity('host')).toMatch(/^host-[a-f0-9]{16}$/);
    expect(makeOpaqueIdentity('internal')).toMatch(/^user-[a-f0-9]{16}$/);
    expect(makeOpaqueIdentity('external')).toMatch(/^guest-[a-f0-9]{16}$/);
    expect(makeOpaqueIdentity('external')).not.toBe(makeOpaqueIdentity('external'));
  });
});

describe('clampMaxParticipants — techo global', () => {
  it('clampa al mínimo entre la sala y el techo global; piso 2', () => {
    expect(clampMaxParticipants(50, SETTINGS)).toBe(20); // techo global gana
    expect(clampMaxParticipants(5, SETTINGS)).toBe(5);
    expect(clampMaxParticipants(0, SETTINGS)).toBe(2); // piso
  });
});

describe('authorizeAndComputeTtl — ventana, allowExternal y TTL', () => {
  const start = new Date('2026-06-30T15:00:00Z');
  const end = new Date('2026-06-30T16:00:00Z');
  const backing = { startAt: start, endAt: end };

  it('personal: sin ventana, ttl = min(cap, 12h)', () => {
    const r = authorizeAndComputeTtl({
      room: { mode: 'personal' },
      backing: null,
      settings: SETTINGS,
      role: 'external',
      now: Date.now(),
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.ttlSeconds).toBe(240 * 60); // cap 4h < 12h
  });

  it('externo en sala sin override y allowExternal=false → 403 external_forbidden', () => {
    const r = authorizeAndComputeTtl({
      room: { mode: 'personal' },
      backing: null,
      settings: { ...SETTINGS, allowExternal: false },
      role: 'external',
      now: Date.now(),
    });
    expect(r).toEqual({ allowed: false, code: 403, reason: 'external_forbidden' });
  });

  it('externo en sala con allowExternalOverride=true → permitido aunque allowExternal=false', () => {
    const r = authorizeAndComputeTtl({
      room: { mode: 'personal', allowExternalOverride: true },
      backing: null,
      settings: { ...SETTINGS, allowExternal: false },
      role: 'external',
      now: Date.now(),
    });
    expect(r.allowed).toBe(true);
  });

  it('per_event: demasiado temprano (antes de start−15m) → 403 too_early (no-host)', () => {
    const now = start.getTime() - EARLY_JOIN_MS - 1000;
    const r = authorizeAndComputeTtl({
      room: { mode: 'per_event' },
      backing,
      settings: SETTINGS,
      role: 'external',
      now,
    });
    expect(r).toEqual({ allowed: false, code: 403, reason: 'too_early' });
  });

  it('per_event: pasada la gracia (después de end+30m) → 403 window_closed (no-host)', () => {
    const now = end.getTime() + GRACE_MS + 1000;
    const r = authorizeAndComputeTtl({
      room: { mode: 'per_event' },
      backing,
      settings: SETTINGS,
      role: 'external',
      now,
    });
    expect(r).toEqual({ allowed: false, code: 403, reason: 'window_closed' });
  });

  it('per_event interno/externo: el TTL NUNCA pasa de end+30m (tope DURO — B-LOW)', () => {
    // A 5m del fin: remaining hasta el tope duro = 35m. El TTL debe ser exactamente eso, no el cap.
    const now = end.getTime() - 5 * 60 * 1000;
    const r = authorizeAndComputeTtl({
      room: { mode: 'per_event' },
      backing,
      settings: SETTINGS,
      role: 'external',
      now,
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) {
      const expiryMs = now + r.ttlSeconds * 1000;
      expect(expiryMs).toBeLessThanOrEqual(end.getTime() + GRACE_MS);
      expect(r.ttlSeconds).toBe(35 * 60); // 5m restantes + 30m gracia
    }
  });

  it('per_event interno/externo: en el último segundo (ttl→0) → 403 window_closed, NO token muerto (B-HIGH)', () => {
    // A 0.5s del tope duro: now ≤ hardEnd (pasa la ventana) pero remainingSec=0. Emitir ttl:0 haría
    // que el SDK aplique su default (≫ tope). Debe rechazarse como ventana cerrada.
    const now = end.getTime() + GRACE_MS - 500;
    const r = authorizeAndComputeTtl({
      room: { mode: 'per_event' },
      backing,
      settings: SETTINGS,
      role: 'external',
      now,
    });
    expect(r).toEqual({ allowed: false, code: 403, reason: 'window_closed' });
  });

  it('per_event: a mitad de ventana el TTL se capa a maxDurationMinutes', () => {
    const now = start.getTime(); // remaining hasta tope = 90m, pero cap = 240m → gana remaining
    const r = authorizeAndComputeTtl({
      room: { mode: 'per_event' },
      backing,
      settings: SETTINGS,
      role: 'internal',
      now,
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.ttlSeconds).toBe(90 * 60); // 60m + 30m gracia, < cap 240m
  });

  it('host: bypassa la ventana (puede abrir antes) con piso de 15m', () => {
    const now = start.getTime() - 5 * 60 * 60 * 1000; // 5h antes
    const r = authorizeAndComputeTtl({
      room: { mode: 'per_event' },
      backing,
      settings: SETTINGS,
      role: 'host',
      now,
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.ttlSeconds).toBe(240 * 60); // remaining grande → capa a cap
  });

  it('host: en sala ya expirada igual obtiene piso de 15m (puede reabrir)', () => {
    const now = end.getTime() + GRACE_MS + 60 * 60 * 1000; // 1h pasada la gracia
    const r = authorizeAndComputeTtl({
      room: { mode: 'per_event' },
      backing,
      settings: SETTINGS,
      role: 'host',
      now,
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.ttlSeconds).toBe(15 * 60);
  });
});
