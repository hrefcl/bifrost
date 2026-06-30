import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { EventType, serializeEventType } from '../EventType.js';
import { AvailabilitySchedule } from '../AvailabilitySchedule.js';
import { Booking } from '../Booking.js';
import { User } from '../User.js';
import {
  getSchedulingSettings,
  setSchedulingSettings,
  DEFAULT_SCHEDULING_SETTINGS,
} from '../../services/scheduling/settings.js';

const oid = (): mongoose.Types.ObjectId => new mongoose.Types.ObjectId();

function bookingDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    eventTypeId: oid(),
    userId: oid(),
    snapshot: {
      timezone: 'America/Santiago',
      durationMinutes: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      minimumNoticeMin: 0,
      title: 'Reunión 30 min',
      location: { type: 'video', value: 'https://meet.example/x' },
    },
    invitee: { name: 'Juan', email: 'juan@cliente.cl', timezone: 'America/Santiago' },
    answers: [],
    status: 'confirmed',
    managementTokenHash: `hash-${Math.random().toString(36).slice(2)}`,
    icsUid: `uid-${Math.random().toString(36).slice(2)}`,
    source: 'public',
  };
  const merged: Record<string, unknown> = { ...base, ...over };
  // endAt se deriva del startAt efectivo (la validación exige endAt>startAt).
  const startAt = (over.startAt as Date | undefined) ?? new Date('2026-07-01T13:00:00.000Z');
  merged.startAt = startAt;
  merged.endAt = (over.endAt as Date | undefined) ?? new Date(startAt.getTime() + 30 * 60_000);
  return merged;
}

describe('Modelos de agenda (Fase 3.1)', () => {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    await Promise.all([
      EventType.syncIndexes(),
      AvailabilitySchedule.syncIndexes(),
      Booking.syncIndexes(),
      User.syncIndexes(),
    ]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  it('EventType: serializa y aplica defaults; slug único POR usuario (no global)', async () => {
    const userId = oid();
    const schedId = oid();
    const ev = await EventType.create({
      userId,
      slug: '30min',
      title: 'Reunión 30 min',
      durationMinutes: 30,
      location: { type: 'video', value: 'https://meet/x' },
      availabilityScheduleId: schedId,
    });
    const dto = serializeEventType(ev);
    expect(dto.slug).toBe('30min');
    expect(dto.bufferBeforeMin).toBe(0); // default
    expect(dto.dateRangeDays).toBe(60); // default
    expect(dto.active).toBe(true);

    // mismo slug, OTRO usuario → permitido
    await expect(
      EventType.create({
        userId: oid(),
        slug: '30min',
        title: 'Otro',
        durationMinutes: 30,
        location: { type: 'phone' },
        availabilityScheduleId: schedId,
      })
    ).resolves.toBeTruthy();

    // mismo slug, MISMO usuario → choca (índice único {userId,slug})
    await expect(
      EventType.create({
        userId,
        slug: '30min',
        title: 'Dup',
        durationMinutes: 30,
        location: { type: 'phone' },
        availabilityScheduleId: schedId,
      })
    ).rejects.toThrow();
  });

  it('Booking: backstop {userId,startAt} sólo bloquea CONFIRMADAS; cancelled libera', async () => {
    const userId = oid();
    await Booking.create(bookingDoc({ userId }));
    // segunda confirmada, mismo userId+startAt → choca (backstop anti-doble-booking)
    await expect(Booking.create(bookingDoc({ userId }))).rejects.toThrow();
    // una CANCELADA en el mismo inicio NO choca (índice parcial status:'confirmed')
    await expect(Booking.create(bookingDoc({ userId, status: 'cancelled' }))).resolves.toBeTruthy();
  });

  it('Booking: idempotencyKeyHash único por {user,eventType}; otro eventType o sin key no choca', async () => {
    const userId = oid();
    const evId = oid();
    await Booking.create(
      bookingDoc({
        userId,
        eventTypeId: evId,
        idempotencyKeyHash: 'k1',
        startAt: new Date('2026-08-01T10:00:00Z'),
      })
    );
    // misma key, mismo user+eventType → choca (idempotencia durable scopeada)
    await expect(
      Booking.create(
        bookingDoc({
          userId,
          eventTypeId: evId,
          idempotencyKeyHash: 'k1',
          startAt: new Date('2026-08-01T11:00:00Z'),
        })
      )
    ).rejects.toThrow();
    // misma key, MISMO user pero OTRO eventType → NO choca (scope por eventType, diseño v3)
    await expect(
      Booking.create(
        bookingDoc({
          userId,
          eventTypeId: oid(),
          idempotencyKeyHash: 'k1',
          startAt: new Date('2026-08-01T12:00:00Z'),
        })
      )
    ).resolves.toBeTruthy();
    // dos sin key NO chocan (índice parcial $type:string)
    await expect(
      Booking.create(bookingDoc({ userId: oid(), startAt: new Date('2026-08-02T10:00:00Z') }))
    ).resolves.toBeTruthy();
    await expect(
      Booking.create(bookingDoc({ userId: oid(), startAt: new Date('2026-08-02T10:00:00Z') }))
    ).resolves.toBeTruthy();
  });

  it('Booking: rechaza endAt <= startAt (estado imposible)', async () => {
    await expect(
      Booking.create(
        bookingDoc({
          startAt: new Date('2026-09-01T10:00:00Z'),
          endAt: new Date('2026-09-01T10:00:00Z'),
        })
      )
    ).rejects.toThrow(/endAt must be after startAt/);
  });

  it('AvailabilitySchedule: formato HH:MM validado (el default vive en User.defaultScheduleId, no aquí)', async () => {
    // dos horarios del MISMO usuario conviven (el default es un puntero en User, no un flag aquí)
    const userId = oid();
    await expect(
      AvailabilitySchedule.create({
        userId,
        name: 'Horario laboral',
        timezone: 'America/Santiago',
        weeklyRules: [{ weekday: 1, intervals: [{ start: '09:00', end: '18:00' }] }],
      })
    ).resolves.toBeTruthy();
    await expect(
      AvailabilitySchedule.create({ userId, name: 'Otro', timezone: 'America/Santiago' })
    ).resolves.toBeTruthy();
    // intervalo con formato inválido → rechazado por el schema
    await expect(
      AvailabilitySchedule.create({
        userId: oid(),
        name: 'Malo',
        timezone: 'UTC',
        weeklyRules: [{ weekday: 1, intervals: [{ start: '9am', end: '18:00' }] }],
      })
    ).rejects.toThrow();
  });

  it('User.username: único parcial; varios sin username conviven, dos con el mismo chocan', async () => {
    await User.create({ primaryEmail: 'a@x.com', displayName: 'A' });
    await User.create({ primaryEmail: 'b@x.com', displayName: 'B' }); // sin username, OK
    await User.create({ primaryEmail: 'c@x.com', displayName: 'C', username: 'ana' });
    await expect(
      User.create({ primaryEmail: 'd@x.com', displayName: 'D', username: 'ana' })
    ).rejects.toThrow();
  });

  it('SchedulingSettings: defaults sin doc; setSchedulingSettings hace upsert+merge', async () => {
    const initial = await getSchedulingSettings();
    expect(initial).toEqual(DEFAULT_SCHEDULING_SETTINGS);
    expect(initial.enabled).toBe(false); // arranca apagada

    const updated = await setSchedulingSettings({
      enabled: true,
      defaults: { durationMinutes: 45 },
    });
    expect(updated.enabled).toBe(true);
    expect(updated.defaults.durationMinutes).toBe(45);
    expect(updated.defaults.dateRangeDays).toBe(60); // merge preserva el resto

    const reread = await getSchedulingSettings();
    expect(reread.enabled).toBe(true);
    expect(reread.defaults.durationMinutes).toBe(45);
  });
});
