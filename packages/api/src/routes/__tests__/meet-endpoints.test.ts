import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Mock del SDK LiveKit (hoisted): el token es un string fijo; createRoom/deleteRoom resuelven.
// Así los tests de ruta no necesitan un servidor LiveKit real (review C-H2: ensureRoom no-fatal).
vi.mock('livekit-server-sdk', () => {
  class AccessToken {
    constructor(_k?: string, _s?: string, _o?: unknown) {}
    addGrant(_g: unknown): void {}
    async toJwt(): Promise<string> {
      return 'header.payload.signature';
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

import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { MeetRoom } from '../../models/MeetRoom.js';
import { Booking } from '../../models/Booking.js';
import { setMeetSettings } from '../../services/meet/settings.js';
import { User } from '../../models/User.js';
import mongoose from 'mongoose';

/** Habilita Meet (settings + credenciales en el entorno). resetState borra SystemConfig → re-habilitar por test. */
async function enableMeet(overrides: Record<string, unknown> = {}) {
  await setMeetSettings({
    enabled: true,
    wsUrl: 'wss://meet.test',
    publicBaseUrl: 'https://webmail.test',
    maxParticipants: 20,
    maxDurationMinutes: 240,
    allowExternal: true,
    auditEnabled: true,
    ...overrides,
  });
}

/** Crea una Booking mínima válida (para tests de backlink). */
async function seedBooking(
  userId: mongoose.Types.ObjectId,
  opts: { status?: 'confirmed' | 'cancelled'; startAt?: Date; endAt?: Date } = {}
) {
  const startAt = opts.startAt ?? new Date(Date.now() - 5 * 60 * 1000); // arrancó hace 5m (en ventana)
  const endAt = opts.endAt ?? new Date(Date.now() + 55 * 60 * 1000);
  return Booking.create({
    eventTypeId: new mongoose.Types.ObjectId(),
    userId,
    snapshot: {
      timezone: 'America/Santiago',
      durationMinutes: 60,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      minimumNoticeMin: 0,
      title: 'Reunión',
      location: { type: 'video', value: 'https://webmail.test/meet/x' },
    },
    startAt,
    endAt,
    invitee: { name: 'Inv', email: 'inv@test.com', timezone: 'America/Santiago' },
    status: opts.status ?? 'confirmed',
    managementTokenHash: 'h',
    icsUid: `uid-${Math.random().toString(36).slice(2)}`,
  });
}

describe('Bifrost Meet — endpoints (F3.1)', () => {
  let app: FastifyInstance;
  const ORIG_KEY = process.env.LIVEKIT_API_KEY;
  const ORIG_SECRET = process.env.LIVEKIT_API_SECRET;

  beforeAll(async () => {
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'devsecret';
    await setupTestDb();
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
    if (ORIG_KEY === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = ORIG_KEY;
    if (ORIG_SECRET === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = ORIG_SECRET;
  });
  beforeEach(async () => {
    await resetState();
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'devsecret';
  });

  // ---- Gate ----
  it('GET /api/config/public refleja meetEnabled', async () => {
    const off = await app.inject({ method: 'GET', url: '/api/config/public' });
    expect(JSON.parse(off.body)).toMatchObject({ meetEnabled: false, livekitWsUrl: '' });
    await enableMeet();
    const on = await app.inject({ method: 'GET', url: '/api/config/public' });
    expect(JSON.parse(on.body)).toMatchObject({
      meetEnabled: true,
      livekitWsUrl: 'wss://meet.test',
      meetPublicBaseUrl: 'https://webmail.test',
    });
  });

  it('gate OFF (settings.enabled=false): POST /rooms → {disabled:true}, sin crear sala', async () => {
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/meet/rooms',
      headers: authHeaders(app, user._id.toString()),
      payload: { name: 'Sala' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ disabled: true });
    expect(await MeetRoom.countDocuments()).toBe(0);
  });

  it('gate OFF por credenciales ausentes aunque enabled=true', async () => {
    await enableMeet();
    delete process.env.LIVEKIT_API_KEY;
    const pub = await app.inject({ method: 'GET', url: '/api/config/public' });
    expect(JSON.parse(pub.body).meetEnabled).toBe(false);
  });

  // ---- Creación + multi-tenant + slug ----
  it('POST /rooms crea sala con slug + meetUrl; GET propio la devuelve', async () => {
    await enableMeet();
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/meet/rooms',
      headers: authHeaders(app, user._id.toString()),
      payload: { name: 'Mi sala', mode: 'personal' },
    });
    expect(res.statusCode).toBe(201);
    const { room } = JSON.parse(res.body) as {
      room: { slug: string; meetUrl: string; mode: string };
    };
    expect(room.slug).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(room.meetUrl).toBe(`https://webmail.test/meet/${room.slug}`);
    expect(room.mode).toBe('personal'); // las salas manuales son SIEMPRE personales (review D-002)

    const get = await app.inject({
      method: 'GET',
      url: `/api/meet/rooms/${room.slug}`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(get.statusCode).toBe(200);
  });

  it('multi-tenant: otro usuario NO ve la sala ajena (404)', async () => {
    await enableMeet();
    const { user: a } = await seedUserWithAccount({ email: 'a@test.com' });
    const { user: b } = await seedUserWithAccount({ email: 'b@test.com' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/meet/rooms',
      headers: authHeaders(app, a._id.toString()),
      payload: { name: 'Sala A' },
    });
    const slug = (JSON.parse(created.body) as { room: { slug: string } }).room.slug;
    const cross = await app.inject({
      method: 'GET',
      url: `/api/meet/rooms/${slug}`,
      headers: authHeaders(app, b._id.toString()),
    });
    expect(cross.statusCode).toBe(404);
  });

  it('slug ÚNICO GLOBAL: insertar dos salas con el mismo slug → E11000', async () => {
    const uid = new mongoose.Types.ObjectId();
    await MeetRoom.create({
      userId: uid,
      slug: 'dup-slug-xyz',
      name: 'r1',
      mode: 'personal',
      status: 'active',
      source: 'manual',
      maxParticipants: 10,
    });
    await expect(
      MeetRoom.create({
        userId: new mongoose.Types.ObjectId(),
        slug: 'dup-slug-xyz',
        name: 'r2',
        mode: 'personal',
        status: 'active',
        source: 'manual',
        maxParticipants: 10,
      })
    ).rejects.toMatchObject({ code: 11000 });
  });

  // ---- 404 idéntico (no enumerable) ----
  it('GET /public/:slug inexistente o cerrado → 404 idéntico', async () => {
    await enableMeet();
    const miss = await app.inject({ method: 'GET', url: '/api/meet/public/nonexistentslug' });
    expect(miss.statusCode).toBe(404);

    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const room = await MeetRoom.create({
      userId: user._id,
      slug: 'closedslug12',
      name: 'r',
      mode: 'personal',
      status: 'closed',
      source: 'manual',
      maxParticipants: 10,
    });
    const closed = await app.inject({ method: 'GET', url: `/api/meet/public/${room.slug}` });
    expect(closed.statusCode).toBe(404);
  });

  // ---- Tokens (roles) ----
  it('POST /rooms/:slug/token: dueño → host; otro autenticado → internal', async () => {
    await enableMeet();
    const { user: a } = await seedUserWithAccount({ email: 'a@test.com' });
    const { user: b } = await seedUserWithAccount({ email: 'b@test.com' });
    const room = await MeetRoom.create({
      userId: a._id,
      slug: 'personalroom1',
      name: 'r',
      mode: 'personal',
      status: 'active',
      source: 'manual',
      maxParticipants: 10,
    });
    const asHost = await app.inject({
      method: 'POST',
      url: `/api/meet/rooms/${room.slug}/token`,
      headers: authHeaders(app, a._id.toString()),
      payload: {},
    });
    expect(asHost.statusCode).toBe(200);
    const hb = JSON.parse(asHost.body) as { role: string; token: string; identity: string };
    expect(hb.role).toBe('host');
    expect(hb.token).toBeTruthy();
    expect(hb.identity).toMatch(/^host-/);

    const asInternal = await app.inject({
      method: 'POST',
      url: `/api/meet/rooms/${room.slug}/token`,
      headers: authHeaders(app, b._id.toString()),
      payload: {},
    });
    expect((JSON.parse(asInternal.body) as { role: string }).role).toBe('internal');
  });

  it('POST /public/:slug/token externo en sala personal con allowExternal=true → 200', async () => {
    await enableMeet({ allowExternal: true });
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const room = await MeetRoom.create({
      userId: user._id,
      slug: 'publicpersonal',
      name: 'r',
      mode: 'personal',
      status: 'active',
      source: 'manual',
      maxParticipants: 10,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/meet/public/${room.slug}/token`,
      payload: { displayName: 'Invitado X' },
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { role: string }).role).toBe('external');
  });

  it('externo bloqueado si allowExternal=false y la sala no tiene override → 403', async () => {
    await enableMeet({ allowExternal: false });
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const room = await MeetRoom.create({
      userId: user._id,
      slug: 'noexternalrm',
      name: 'r',
      mode: 'personal',
      status: 'active',
      source: 'manual',
      maxParticipants: 10,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/meet/public/${room.slug}/token`,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  // ---- Backlink (booking) ----
  it('sala booking con backlink CANCELADO → token 404 (slug huérfano no mintea)', async () => {
    await enableMeet();
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const booking = await seedBooking(user._id, { status: 'cancelled' });
    const room = await MeetRoom.create({
      userId: user._id,
      slug: 'bookingcancel',
      name: 'r',
      mode: 'per_event',
      status: 'active',
      source: 'booking',
      bookingId: booking._id,
      allowExternalOverride: true,
      maxParticipants: 10,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/meet/public/${room.slug}/token`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /public/:slug de sala booking CANCELADA → 404 (metadata no observable, review B-MED/C-L3)', async () => {
    await enableMeet();
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const booking = await seedBooking(user._id, { status: 'cancelled' });
    const room = await MeetRoom.create({
      userId: user._id,
      slug: 'metacancel12',
      name: 'r',
      mode: 'per_event',
      status: 'active',
      source: 'booking',
      bookingId: booking._id,
      allowExternalOverride: true,
      maxParticipants: 10,
    });
    const meta = await app.inject({ method: 'GET', url: `/api/meet/public/${room.slug}` });
    expect(meta.statusCode).toBe(404);
  });

  it('sala booking confirmada y en ventana → token 200', async () => {
    await enableMeet();
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const booking = await seedBooking(user._id, { status: 'confirmed' });
    const room = await MeetRoom.create({
      userId: user._id,
      slug: 'bookingokroom',
      name: 'r',
      mode: 'per_event',
      status: 'active',
      source: 'booking',
      bookingId: booking._id,
      allowExternalOverride: true,
      maxParticipants: 10,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/meet/public/${room.slug}/token`,
      payload: { displayName: 'Inv' },
    });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body) as { expiresInSeconds: number };
    expect(b.expiresInSeconds).toBeGreaterThan(0);
  });

  it('sala booking fuera de ventana (futura lejana) → 403 too_early', async () => {
    await enableMeet();
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const booking = await seedBooking(user._id, {
      status: 'confirmed',
      startAt: future,
      endAt: new Date(future.getTime() + 60 * 60 * 1000),
    });
    const room = await MeetRoom.create({
      userId: user._id,
      slug: 'bookingfuture',
      name: 'r',
      mode: 'per_event',
      status: 'active',
      source: 'booking',
      bookingId: booking._id,
      allowExternalOverride: true,
      maxParticipants: 10,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/meet/public/${room.slug}/token`,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).message).toBe('too_early');
  });

  // ---- Host cancel cierra la sala (review D-001) ----
  it('POST /api/schedule/bookings/:id/cancel (host) cierra la MeetRoom de la reserva', async () => {
    await enableMeet();
    const { user } = await seedUserWithAccount({ email: 'host@test.com' });
    const booking = await seedBooking(user._id, { status: 'confirmed' });
    const room = await MeetRoom.create({
      userId: user._id,
      slug: 'hostcancelrm1',
      name: 'r',
      mode: 'per_event',
      status: 'active',
      source: 'booking',
      bookingId: booking._id,
      allowExternalOverride: true,
      maxParticipants: 10,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/schedule/bookings/${booking._id.toString()}/cancel`,
      headers: authHeaders(app, user._id.toString()),
      payload: { reason: 'no va' },
    });
    expect(res.statusCode).toBe(200);
    const after = await MeetRoom.findById(room._id);
    expect(after?.status).toBe('closed');
  });

  // ---- Admin settings ----
  it('GET/PATCH /api/admin/meet/settings exige admin', async () => {
    const { user } = await seedUserWithAccount({ email: 'user@test.com' });
    const noAdmin = await app.inject({
      method: 'GET',
      url: '/api/admin/meet/settings',
      headers: authHeaders(app, user._id.toString()),
    });
    expect(noAdmin.statusCode).toBe(403);

    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const asAdmin = await app.inject({
      method: 'PATCH',
      url: '/api/admin/meet/settings',
      headers: authHeaders(app, user._id.toString()),
      payload: { enabled: true, maxParticipants: 12 },
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(
      (JSON.parse(asAdmin.body) as { settings: { maxParticipants: number } }).settings
        .maxParticipants
    ).toBe(12);
  });

  // ---- rotate / delete ----
  it('rotate cambia el slug de una sala personal; el viejo deja de resolver', async () => {
    await enableMeet();
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const room = await MeetRoom.create({
      userId: user._id,
      slug: 'rotateme123',
      name: 'r',
      mode: 'personal',
      status: 'active',
      source: 'manual',
      maxParticipants: 10,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/meet/rooms/${room.slug}/rotate`,
      headers: authHeaders(app, user._id.toString()),
    });
    expect(res.statusCode).toBe(200);
    const newSlug = (JSON.parse(res.body) as { room: { slug: string } }).room.slug;
    expect(newSlug).not.toBe('rotateme123');
    const old = await app.inject({ method: 'GET', url: '/api/meet/public/rotateme123' });
    expect(old.statusCode).toBe(404);
  });
});
