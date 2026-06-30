import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { AvailabilitySchedule } from '../../models/AvailabilitySchedule.js';
import { EventType } from '../../models/EventType.js';
import { Booking } from '../../models/Booking.js';
import { CalendarEvent } from '../../models/CalendarEvent.js';

describe('Fase 3.3 — APIs host de agenda', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDb();
    app = await buildTestApp();
    await Promise.all([
      AvailabilitySchedule.syncIndexes(),
      EventType.syncIndexes(),
      Booking.syncIndexes(),
    ]);
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  const post = (uid: string, url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: authHeaders(app, uid), payload });
  const patch = (uid: string, url: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url, headers: authHeaders(app, uid), payload });
  const get = (uid: string, url: string) =>
    app.inject({ method: 'GET', url, headers: authHeaders(app, uid) });
  const del = (uid: string, url: string) =>
    app.inject({ method: 'DELETE', url, headers: authHeaders(app, uid) });

  async function seedSchedule(uid: string) {
    const r = await post(uid, '/api/schedule/availability', {
      name: 'Horario laboral',
      timezone: 'America/Santiago',
      weeklyRules: [{ weekday: 1, intervals: [{ start: '09:00', end: '18:00' }] }],
    });
    return JSON.parse(r.body) as { id: string; isDefault: boolean };
  }

  // ───────── AVAILABILITY ─────────
  it('availability: el primer horario se fuerza default; un 2º con isDefault desmarca al anterior', async () => {
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const uid = user._id.toString();
    const first = await seedSchedule(uid);
    expect(first.isDefault).toBe(true);
    const second = await post(uid, '/api/schedule/availability', {
      name: 'Otro',
      timezone: 'America/Santiago',
      isDefault: true,
    });
    expect(second.statusCode).toBe(200);
    const list = JSON.parse((await get(uid, '/api/schedule/availability')).body) as {
      id: string;
      isDefault: boolean;
    }[];
    expect(list.filter((s) => s.isDefault)).toHaveLength(1);
    expect(list.find((s) => s.isDefault)?.id).toBe((JSON.parse(second.body) as { id: string }).id);
  });

  it('availability: rechaza tz inválida, intervalo end<=start y 24:00 como inicio', async () => {
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const uid = user._id.toString();
    expect(
      (await post(uid, '/api/schedule/availability', { name: 'x', timezone: 'X/Y' })).statusCode
    ).toBe(400);
    expect(
      (
        await post(uid, '/api/schedule/availability', {
          name: 'x',
          timezone: 'UTC',
          weeklyRules: [{ weekday: 1, intervals: [{ start: '18:00', end: '09:00' }] }],
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await post(uid, '/api/schedule/availability', {
          name: 'x',
          timezone: 'UTC',
          weeklyRules: [{ weekday: 1, intervals: [{ start: '24:00', end: '24:00' }] }],
        })
      ).statusCode
    ).toBe(400);
  });

  // ───────── EVENT TYPES ─────────
  async function seedEventType(uid: string, scheduleId: string, slug = '30min') {
    return post(uid, '/api/schedule/event-types', {
      slug,
      title: 'Reunión 30 min',
      durationMinutes: 30,
      location: { type: 'video', value: 'https://meet/x' },
      availabilityScheduleId: scheduleId,
    });
  }

  it('event-types: crea, lista, slug duplicado → 409, slug reservado/ inválido → 400', async () => {
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const uid = user._id.toString();
    const sched = await seedSchedule(uid);
    const created = await seedEventType(uid, sched.id, '30min');
    expect(created.statusCode).toBe(200);
    // duplicado
    expect((await seedEventType(uid, sched.id, '30min')).statusCode).toBe(409);
    // slug inválido (mayúsculas/espacios) y reservado
    expect((await seedEventType(uid, sched.id, 'Con Espacio')).statusCode).toBe(400);
    expect((await seedEventType(uid, sched.id, 'booking')).statusCode).toBe(400); // reservado
    // availabilityScheduleId ajeno/inexistente → 400
    const bad = await post(uid, '/api/schedule/event-types', {
      slug: 'otro',
      title: 'x',
      durationMinutes: 30,
      location: { type: 'phone' },
      availabilityScheduleId: '0'.repeat(24),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('event-types: DELETE es SOFT (active:false), no borra', async () => {
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const uid = user._id.toString();
    const sched = await seedSchedule(uid);
    const ev = JSON.parse((await seedEventType(uid, sched.id)).body) as { id: string };
    expect((await del(uid, `/api/schedule/event-types/${ev.id}`)).statusCode).toBe(200);
    const after = JSON.parse((await get(uid, `/api/schedule/event-types/${ev.id}`)).body) as {
      active: boolean;
    };
    expect(after.active).toBe(false);
  });

  it('availability: borrar el default auto-promueve otro (invariante exactamente-uno)', async () => {
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const uid = user._id.toString();
    const first = await seedSchedule(uid); // default
    const second = JSON.parse(
      (await post(uid, '/api/schedule/availability', { name: 'Otro', timezone: 'UTC' })).body
    ) as { id: string; isDefault: boolean };
    expect(second.isDefault).toBe(false);
    expect((await del(uid, `/api/schedule/availability/${first.id}`)).statusCode).toBe(200);
    const list = JSON.parse((await get(uid, '/api/schedule/availability')).body) as {
      id: string;
      isDefault: boolean;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true); // el restante quedó como default
  });

  it('availability: no se puede borrar si un EventType la usa → 409', async () => {
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const uid = user._id.toString();
    const sched = await seedSchedule(uid);
    await seedEventType(uid, sched.id);
    expect((await del(uid, `/api/schedule/availability/${sched.id}`)).statusCode).toBe(409);
  });

  // ───────── IDOR ─────────
  it('IDOR: usuario B no accede a recursos de A (404)', async () => {
    const a = await seedUserWithAccount({ email: 'a@test.com' });
    const b = await seedUserWithAccount({ email: 'b@test.com' });
    const uidA = a.user._id.toString();
    const uidB = b.user._id.toString();
    const sched = await seedSchedule(uidA);
    const ev = JSON.parse((await seedEventType(uidA, sched.id)).body) as { id: string };
    expect((await get(uidB, `/api/schedule/event-types/${ev.id}`)).statusCode).toBe(404);
    expect(
      (await patch(uidB, `/api/schedule/availability/${sched.id}`, { name: 'hack' })).statusCode
    ).toBe(404);
  });

  // ───────── PROFILE (username) ─────────
  it('profile: set username válido, reservado→400, duplicado→409, vaciar→unset', async () => {
    const a = await seedUserWithAccount({ email: 'a@test.com' });
    const b = await seedUserWithAccount({ email: 'b@test.com' });
    const uidA = a.user._id.toString();
    const uidB = b.user._id.toString();
    expect((await patch(uidA, '/api/schedule/profile', { username: 'Ana' })).statusCode).toBe(200);
    expect(JSON.parse((await get(uidA, '/api/schedule/profile')).body).username).toBe('ana'); // normalizado
    expect((await patch(uidB, '/api/schedule/profile', { username: 'admin' })).statusCode).toBe(
      400
    ); // reservado
    expect((await patch(uidB, '/api/schedule/profile', { username: 'ana' })).statusCode).toBe(409); // duplicado
    // vaciar
    expect((await patch(uidA, '/api/schedule/profile', { username: '' })).statusCode).toBe(200);
    expect(JSON.parse((await get(uidA, '/api/schedule/profile')).body).username).toBeNull();
    // ahora B sí puede tomar 'ana'
    expect((await patch(uidB, '/api/schedule/profile', { username: 'ana' })).statusCode).toBe(200);
  });

  // ───────── BOOKINGS (host) ─────────
  it('bookings: lista propias y cancela una confirmada (cancela también el CalendarEvent)', async () => {
    const { user } = await seedUserWithAccount({ email: 'a@test.com' });
    const uid = user._id.toString();
    const ce = await CalendarEvent.create({
      userId: user._id,
      accountId: user._id, // cualquier ObjectId para el test
      calendarId: 'bifrost-scheduling',
      calendarName: 'Reuniones',
      uid: 'ics-1',
      summary: 'Reunión',
      startDate: new Date('2026-07-07T14:00:00Z'),
      endDate: new Date('2026-07-07T14:30:00Z'),
      source: 'booking',
    });
    const booking = await Booking.create({
      eventTypeId: ce._id,
      userId: user._id,
      snapshot: {
        timezone: 'America/Santiago',
        durationMinutes: 30,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        minimumNoticeMin: 0,
        title: 'Reunión',
        location: { type: 'video' },
      },
      startAt: new Date('2026-07-07T14:00:00Z'),
      endAt: new Date('2026-07-07T14:30:00Z'),
      invitee: { name: 'Juan', email: 'juan@x.com', timezone: 'America/Santiago' },
      managementTokenHash: 'h1',
      icsUid: 'ics-1',
      calendarEventId: ce._id,
    });
    const list = JSON.parse((await get(uid, '/api/schedule/bookings')).body) as { id: string }[];
    expect(list).toHaveLength(1);
    const cancel = await post(uid, `/api/schedule/bookings/${booking._id.toString()}/cancel`, {
      reason: 'test',
    });
    expect(cancel.statusCode).toBe(200);
    expect(JSON.parse(cancel.body).status).toBe('cancelled');
    const ceAfter = await CalendarEvent.findById(ce._id).lean();
    expect(ceAfter?.status).toBe('cancelled');
    // cancelar de nuevo → 200 idempotente (devuelve la reserva ya cancelada)
    const again = await post(uid, `/api/schedule/bookings/${booking._id.toString()}/cancel`, {});
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body).status).toBe('cancelled');
  });
});
