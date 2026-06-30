import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
} from '../../../test/integration-helper.js';
import { User } from '../../models/User.js';
import { Account } from '../../models/Account.js';
import { AvailabilitySchedule } from '../../models/AvailabilitySchedule.js';
import { EventType } from '../../models/EventType.js';
import { Booking } from '../../models/Booking.js';
import { CalendarEvent } from '../../models/CalendarEvent.js';
import { setSchedulingSettings } from '../../services/scheduling/settings.js';

describe('Fase 3.4 — rutas públicas de agenda', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDb();
    app = await buildTestApp();
    await Promise.all([Booking.syncIndexes(), EventType.syncIndexes()]);
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
    await setSchedulingSettings({ enabled: true });
  });

  async function seedHost() {
    const user = await User.create({
      primaryEmail: 'ana@t.com',
      displayName: 'Ana',
      username: 'ana',
    });
    await Account.create({
      userId: user._id,
      name: 'Ana',
      email: 'ana@t.com',
      isPrimary: true,
      imap: {
        host: 'h',
        port: 993,
        secure: true,
        authMethod: 'password',
        authUser: 'u',
        authCredentialsEncrypted: { ciphertext: 'x', iv: 'y', tag: 'z' },
      },
      smtp: {
        host: 'h',
        port: 465,
        secure: true,
        authMethod: 'password',
        authUser: 'u',
        authCredentialsEncrypted: { ciphertext: 'x', iv: 'y', tag: 'z' },
      },
      status: 'active',
    });
    const sched = await AvailabilitySchedule.create({
      userId: user._id,
      name: 'Laboral',
      timezone: 'America/Bogota',
      weeklyRules: [{ weekday: 1, intervals: [{ start: '09:00', end: '18:00' }] }],
    });
    await EventType.create({
      userId: user._id,
      slug: '30min',
      title: 'Reunión 30 min',
      durationMinutes: 30,
      location: { type: 'video', value: 'https://meet/x' },
      availabilityScheduleId: sched._id,
    });
    return user;
  }

  const inj = (
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>
  ) => app.inject({ method, url, payload, headers });

  it('perfil público lista tipos activos; usuario inexistente → 404', async () => {
    await seedHost();
    const r = await inj('GET', '/api/schedule/public/ana');
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as {
      username: string;
      eventTypes: { slug: string; location: { type: string; value?: string } }[];
    };
    expect(body.username).toBe('ana');
    expect(body.eventTypes.map((e) => e.slug)).toContain('30min');
    expect((await inj('GET', '/api/schedule/public/noexiste')).statusCode).toBe(404);
    // Privacidad (review B-HIGH): el DTO público NO debe filtrar location.value (URL de videollamada).
    const ev = body.eventTypes.find((e) => e.slug === '30min');
    expect(ev?.location.type).toBe('video');
    expect(ev?.location.value).toBeUndefined();
  });

  it('detalle público de un tipo tampoco expone location.value', async () => {
    await seedHost();
    const r = await inj('GET', '/api/schedule/public/ana/30min');
    expect(r.statusCode).toBe(200);
    const ev = JSON.parse(r.body) as { location: { type: string; value?: string } };
    expect(ev.location.value).toBeUndefined();
  });

  it('gate: con scheduling deshabilitado, el perfil y book dan 404', async () => {
    await seedHost();
    await setSchedulingSettings({ enabled: false });
    expect((await inj('GET', '/api/schedule/public/ana')).statusCode).toBe(404);
    expect(
      (
        await inj('POST', '/api/schedule/public/ana/30min/book', {
          startAt: '2026-07-06T14:00:00.000Z',
          invitee: { name: 'J', email: 'j@x.com', timezone: 'UTC' },
        })
      ).statusCode
    ).toBe(404);
  });

  it('slots: devuelve huecos; valida ventana y tz', async () => {
    await seedHost();
    const r = await inj(
      'GET',
      '/api/schedule/public/ana/30min/slots?from=2026-07-06T00:00:00.000Z&to=2026-07-07T00:00:00.000Z'
    );
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { slots: { start: string }[] };
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.slots[0].start).toBe('2026-07-06T14:00:00.000Z'); // 09:00 Bogota
    // tz inválida → 400
    const bad = await inj(
      'GET',
      '/api/schedule/public/ana/30min/slots?from=2026-07-06T00:00:00.000Z&to=2026-07-07T00:00:00.000Z&tz=X/Y'
    );
    expect(bad.statusCode).toBe(400);
  });

  it('book → 201 + managementToken; cancel por token → cancelled; token inválido → 404', async () => {
    await seedHost();
    const booked = await inj('POST', '/api/schedule/public/ana/30min/book', {
      startAt: '2026-07-06T14:00:00.000Z',
      invitee: { name: 'Juan', email: 'juan@x.com', timezone: 'America/Santiago' },
    });
    expect(booked.statusCode).toBe(201);
    const { booking, managementToken } = JSON.parse(booked.body) as {
      booking: { id: string; status: string };
      managementToken: string;
    };
    expect(booking.status).toBe('confirmed');
    expect(managementToken).toBeTruthy();
    // doble booking del mismo slot → 409
    const dup = await inj('POST', '/api/schedule/public/ana/30min/book', {
      startAt: '2026-07-06T14:00:00.000Z',
      invitee: { name: 'Otro', email: 'o@x.com', timezone: 'UTC' },
    });
    expect(dup.statusCode).toBe(409);
    // gestión por token → ver + cancelar
    const view = await inj('GET', `/api/schedule/public/booking/${managementToken}`);
    expect(view.statusCode).toBe(200);
    const cancel = await inj('POST', `/api/schedule/public/booking/${managementToken}/cancel`, {});
    expect(cancel.statusCode).toBe(200);
    expect(JSON.parse(cancel.body).status).toBe('cancelled');
    // token basura → 404
    expect((await inj('GET', '/api/schedule/public/booking/' + 'z'.repeat(40))).statusCode).toBe(
      404
    );
    // tras cancelar, el CalendarEvent quedó cancelado y el slot libre
    expect(await CalendarEvent.countDocuments({ status: 'confirmed', source: 'booking' })).toBe(0);
  });

  it('reschedule por token: crea nueva, invalida el token viejo (410)', async () => {
    await seedHost();
    const booked = await inj('POST', '/api/schedule/public/ana/30min/book', {
      startAt: '2026-07-06T14:00:00.000Z',
      invitee: { name: 'Juan', email: 'juan@x.com', timezone: 'UTC' },
    });
    const { managementToken: oldToken } = JSON.parse(booked.body) as { managementToken: string };
    const resched = await inj('POST', `/api/schedule/public/booking/${oldToken}/reschedule`, {
      startAt: '2026-07-06T15:00:00.000Z', // 10:00 Bogota, otro slot válido
    });
    expect(resched.statusCode).toBe(200);
    const { managementToken: newToken } = JSON.parse(resched.body) as { managementToken: string };
    expect(newToken).not.toBe(oldToken);
    // token viejo → 410 (la reserva quedó rescheduled)
    expect(
      (await inj('POST', `/api/schedule/public/booking/${oldToken}/cancel`, {})).statusCode
    ).toBe(410);
    // sólo 1 confirmada
    expect(await Booking.countDocuments({ status: 'confirmed' })).toBe(1);
  });
});
