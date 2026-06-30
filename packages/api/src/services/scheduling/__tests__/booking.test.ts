import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User } from '../../../models/User.js';
import { Account } from '../../../models/Account.js';
import { AvailabilitySchedule } from '../../../models/AvailabilitySchedule.js';
import { EventType, type IEventType } from '../../../models/EventType.js';
import { Booking } from '../../../models/Booking.js';
import { CalendarEvent } from '../../../models/CalendarEvent.js';
import { createBooking, cancelBooking, resolveSchedule } from '../booking-service.js';
import { runReconcile } from '../reconciler.js';

// startAt: lunes 2026-07-06 09:00 America/Bogota (UTC-5) = 14:00:00Z. now lejano antes.
const START = new Date('2026-07-06T14:00:00.000Z');
const NOW = new Date('2026-07-01T00:00:00.000Z');

describe('Fase 3.4 — booking service (concurrencia/idempotencia/compensación)', () => {
  let server: MongoMemoryServer;
  let hostId: string;
  let accountId: string;
  let eventType: IEventType;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    await Promise.all([
      Booking.syncIndexes(),
      EventType.syncIndexes(),
      CalendarEvent.syncIndexes(),
    ]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Account.deleteMany({}),
      AvailabilitySchedule.deleteMany({}),
      EventType.deleteMany({}),
      Booking.deleteMany({}),
      CalendarEvent.deleteMany({}),
    ]);
    const user = await User.create({
      primaryEmail: 'ana@test.com',
      displayName: 'Ana',
      username: 'ana',
    });
    hostId = user._id.toString();
    const sched = await AvailabilitySchedule.create({
      userId: user._id,
      name: 'Laboral',
      timezone: 'America/Bogota',
      weeklyRules: [{ weekday: 1, intervals: [{ start: '09:00', end: '18:00' }] }],
    });
    eventType = await EventType.create({
      userId: user._id,
      slug: '30min',
      title: 'Reunión 30 min',
      durationMinutes: 30,
      location: { type: 'video', value: 'https://meet/x' },
      availabilityScheduleId: sched._id,
    });
    accountId = new mongoose.Types.ObjectId().toString();
  });

  const args = (over: Record<string, unknown> = {}) => ({
    eventType,
    schedule: resolveSchedule({
      timezone: 'America/Bogota',
      weeklyRules: [{ weekday: 1, intervals: [{ start: '09:00', end: '18:00' }] }],
      overrides: [],
    }),
    hostUserId: hostId,
    hostAccountId: accountId,
    startAt: START,
    now: NOW,
    invitee: { name: 'Juan', email: 'juan@cliente.cl', timezone: 'America/Santiago' },
    answers: [],
    ...over,
  });

  it('crea una reserva + su CalendarEvent (proyección)', async () => {
    const r = await createBooking(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rawToken).toBeTruthy();
    expect(r.booking.calendarEventId).toBeTruthy();
    const ce = await CalendarEvent.findById(r.booking.calendarEventId);
    expect(ce?.source).toBe('booking');
    expect(ce?.uid).toBe(r.booking.icsUid);
  });

  it('CONCURRENCIA: N invitados DISTINTOS al mismo slot → exactamente 1 gana', async () => {
    const N = 6;
    // invitados distintos → cada uno tiene su propia idempotency derivada → contención REAL por el slot.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        createBooking(
          args({
            invitee: {
              name: `U${String(i)}`,
              email: `u${String(i)}@x.com`,
              timezone: 'America/Santiago',
            },
          })
        )
      )
    );
    const won = results.filter((r) => r.ok);
    expect(won).toHaveLength(1);
    expect(await Booking.countDocuments({ status: 'confirmed' })).toBe(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(N - 1);
  });

  it('IDEMPOTENCIA por fingerprint: N requests del MISMO invitado+slot → 1 reserva (resto replay)', async () => {
    const N = 4;
    const results = await Promise.all(Array.from({ length: N }, () => createBooking(args())));
    expect(results.every((r) => r.ok)).toBe(true); // todos ok (1 real + replays)
    expect(await Booking.countDocuments()).toBe(1); // pero UNA sola reserva
  });

  it('IDEMPOTENCIA: misma Idempotency-Key → replay de la misma reserva (no crea otra)', async () => {
    const first = await createBooking(args({ idempotencyKey: 'k-123' }));
    const second = await createBooking(args({ idempotencyKey: 'k-123' }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.replay).toBe(true);
    expect(second.booking._id.toString()).toBe(first.booking._id.toString());
    expect(await Booking.countDocuments()).toBe(1);
  });

  it('COMPENSACIÓN: si falla el insert del CalendarEvent, la Booking se borra y propaga', async () => {
    const spy = vi
      .spyOn(CalendarEvent, 'create')
      .mockRejectedValueOnce(new Error('CE down') as never);
    await expect(createBooking(args())).rejects.toThrow('CE down');
    expect(await Booking.countDocuments()).toBe(0); // compensada
    spy.mockRestore();
  });

  it('cancelar libera el slot (Booking + CalendarEvent cancelados) y permite re-reservar', async () => {
    const r = await createBooking(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await cancelBooking(r.booking, 'invitee');
    expect((await Booking.findById(r.booking._id))?.status).toBe('cancelled');
    expect((await CalendarEvent.findById(r.booking.calendarEventId))?.status).toBe('cancelled');
    // el mismo slot vuelve a estar libre
    const again = await createBooking(args());
    expect(again.ok).toBe(true);
  });

  it('RECONCILER: una Booking confirmada sin CalendarEvent → se le crea/enlaza', async () => {
    await Account.create({
      userId: new mongoose.Types.ObjectId(hostId),
      name: 'Ana',
      email: 'ana@test.com',
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
    const b = await Booking.create({
      eventTypeId: eventType._id,
      userId: new mongoose.Types.ObjectId(hostId),
      snapshot: {
        timezone: 'America/Bogota',
        durationMinutes: 30,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        minimumNoticeMin: 0,
        title: 'R',
        location: { type: 'video' },
      },
      startAt: START,
      endAt: new Date(START.getTime() + 30 * 60000),
      invitee: { name: 'Juan', email: 'j@x.com', timezone: 'UTC' },
      managementTokenHash: 'h1',
      icsUid: 'uid-recon-1',
      status: 'confirmed',
    });
    // backdatear createdAt vía colección RAW (Mongoose timestamps no deja tocar createdAt en updateOne):
    // el reconciler tiene grace de 60s para no pisar un create en vuelo.
    await mongoose.connection
      .db!.collection('bookings')
      .updateOne({ _id: b._id }, { $set: { createdAt: new Date(Date.now() - 120_000) } });
    const res = await runReconcile();
    expect(res.linked).toBe(1);
    const after = await Booking.findById(b._id);
    expect(after?.calendarEventId).toBeTruthy();
    const ce = await CalendarEvent.findById(after?.calendarEventId);
    expect(ce?.uid).toBe('uid-recon-1');
  });

  it('RECONCILER reschedule crash POST-retire/PRE-unset: NO cancela la nueva, sólo limpia (review B-HIGH)', async () => {
    const userId = new mongoose.Types.ObjectId(hostId);
    const snap = {
      timezone: 'America/Bogota',
      durationMinutes: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      minimumNoticeMin: 0,
      title: 'R',
      location: { type: 'video' as const },
    };
    // vieja YA retirada (rescheduled) apuntando a la nueva; la nueva quedó con pendingReschedule (crash antes del unset).
    const oldB = await Booking.create({
      eventTypeId: eventType._id,
      userId,
      snapshot: snap,
      startAt: START,
      endAt: new Date(START.getTime() + 30 * 60000),
      invitee: { name: 'J', email: 'j@x.com', timezone: 'UTC' },
      managementTokenHash: 'old',
      icsUid: 'u-old',
      status: 'rescheduled',
    });
    const neo = await Booking.create({
      eventTypeId: eventType._id,
      userId,
      snapshot: snap,
      startAt: new Date(START.getTime() + 3600000),
      endAt: new Date(START.getTime() + 3600000 + 30 * 60000),
      invitee: { name: 'J', email: 'j@x.com', timezone: 'UTC' },
      managementTokenHash: 'neo',
      icsUid: 'u-neo',
      status: 'confirmed',
      rescheduledFromId: oldB._id,
      pendingReschedule: true,
    });
    await Booking.updateOne({ _id: oldB._id }, { $set: { rescheduledToId: neo._id } });
    await mongoose.connection
      .db!.collection('bookings')
      .updateMany({}, { $set: { createdAt: new Date(Date.now() - 120_000) } });
    await runReconcile();
    const neoAfter = await Booking.findById(neo._id);
    expect(neoAfter?.status).toBe('confirmed'); // NO se canceló
    expect(neoAfter?.pendingReschedule).toBeFalsy(); // flag limpiado
  });

  it('RECONCILER: neo SUPERSEDED (la vieja se reagendó a OTRA) → se cancela (review B-HIGH)', async () => {
    const userId = new mongoose.Types.ObjectId(hostId);
    const snap = {
      timezone: 'America/Bogota',
      durationMinutes: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      minimumNoticeMin: 0,
      title: 'R',
      location: { type: 'video' as const },
    };
    const neoB = await Booking.create({
      eventTypeId: eventType._id,
      userId,
      snapshot: snap,
      startAt: new Date(START.getTime() + 7200000),
      endAt: new Date(START.getTime() + 7200000 + 30 * 60000),
      invitee: { name: 'J', email: 'j@x.com', timezone: 'UTC' },
      managementTokenHash: 'neoB',
      icsUid: 'u-neoB',
      status: 'confirmed',
    });
    // vieja reagendada a neoB (el reintento ganó)
    const oldB = await Booking.create({
      eventTypeId: eventType._id,
      userId,
      snapshot: snap,
      startAt: START,
      endAt: new Date(START.getTime() + 30 * 60000),
      invitee: { name: 'J', email: 'j@x.com', timezone: 'UTC' },
      managementTokenHash: 'oldS',
      icsUid: 'u-oldS',
      status: 'rescheduled',
      rescheduledToId: neoB._id,
    });
    // neoA fantasma del intento crasheado
    const neoACe = await CalendarEvent.create({
      userId,
      accountId: new mongoose.Types.ObjectId(),
      calendarId: 'bifrost-scheduling',
      calendarName: 'Reuniones',
      uid: 'u-neoA',
      summary: 'R',
      startDate: new Date(START.getTime() + 3600000),
      endDate: new Date(START.getTime() + 3600000 + 30 * 60000),
      status: 'confirmed',
      source: 'booking',
    });
    const neoA = await Booking.create({
      eventTypeId: eventType._id,
      userId,
      snapshot: snap,
      startAt: new Date(START.getTime() + 3600000),
      endAt: new Date(START.getTime() + 3600000 + 30 * 60000),
      invitee: { name: 'J', email: 'j@x.com', timezone: 'UTC' },
      managementTokenHash: 'neoA',
      icsUid: 'u-neoA',
      status: 'confirmed',
      rescheduledFromId: oldB._id,
      pendingReschedule: true,
      calendarEventId: neoACe._id,
    });
    await mongoose.connection
      .db!.collection('bookings')
      .updateMany({}, { $set: { createdAt: new Date(Date.now() - 120_000) } });
    await runReconcile();
    expect((await Booking.findById(neoA._id))?.status).toBe('cancelled'); // fantasma cancelada
    expect((await CalendarEvent.findById(neoACe._id))?.status).toBe('cancelled'); // su CE también
    expect((await Booking.findById(neoB._id))?.status).toBe('confirmed'); // la legítima intacta
  });
});
