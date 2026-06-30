import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';

// Mock LiveKit (hoisted): cancel/reschedule llaman closeLiveKitRoom (RPC) — sin servidor real.
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

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User } from '../../../models/User.js';
import { AvailabilitySchedule } from '../../../models/AvailabilitySchedule.js';
import { EventType, type IEventType } from '../../../models/EventType.js';
import { Booking } from '../../../models/Booking.js';
import { CalendarEvent } from '../../../models/CalendarEvent.js';
import { MeetRoom } from '../../../models/MeetRoom.js';
import {
  createBooking,
  cancelBooking,
  rescheduleBooking,
  resolveSchedule,
} from '../booking-service.js';
import { setMeetSettings } from '../../meet/settings.js';
import * as bookingMeet from '../../meet/booking-meet.js';

const START = new Date('2026-07-06T14:00:00.000Z'); // lunes 09:00 America/Bogota
const NOW = new Date('2026-07-01T00:00:00.000Z');

describe('F3.2 — integración booking ↔ Bifrost Meet', () => {
  let server: MongoMemoryServer;
  let hostId: string;
  let accountId: string;
  let eventType: IEventType;

  beforeAll(async () => {
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'devsecret';
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    await Promise.all([
      Booking.syncIndexes(),
      EventType.syncIndexes(),
      CalendarEvent.syncIndexes(),
      MeetRoom.syncIndexes(),
    ]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
  });
  beforeEach(async () => {
    const db = mongoose.connection.db;
    for (const c of (await db?.collections()) ?? []) await c.deleteMany({});
    await setMeetSettings({
      enabled: true,
      wsUrl: 'wss://meet.test',
      publicBaseUrl: 'https://webmail.test',
      maxParticipants: 20,
      maxDurationMinutes: 240,
      allowExternal: true,
    });
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
      location: { type: 'in_person', value: 'Oficina' },
      availabilityScheduleId: sched._id,
      meetEnabled: true, // ← este tipo genera sala Meet
    });
    accountId = new mongoose.Types.ObjectId().toString();
  });
  afterEach(() => {
    vi.restoreAllMocks(); // limpia los spies (no afecta el vi.mock de livekit-server-sdk)
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

  it('reserva con meetEnabled → crea MeetRoom (source:booking, override:true) y hornea la URL en el snapshot', async () => {
    const r = await createBooking(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const room = await MeetRoom.findOne({ bookingId: r.booking._id });
    expect(room).toBeTruthy();
    expect(room?.source).toBe('booking');
    expect(room?.mode).toBe('per_event');
    expect(room?.allowExternalOverride).toBe(true);
    expect(room?.expiresAt?.getTime()).toBe(r.booking.endAt.getTime() + 30 * 60 * 1000);

    // snapshot HORNEADO con la URL de Meet (link inmutable que el email/ICS leerán).
    expect(r.booking.snapshot.location.type).toBe('video');
    expect(r.booking.snapshot.location.value).toBe(`https://webmail.test/meet/${room?.slug}`);

    // CalendarEvent lleva meetRoomId/meetUrl + location = URL horneada.
    const ce = await CalendarEvent.findById(r.booking.calendarEventId);
    expect(ce?.meetRoomId?.toString()).toBe(room?._id.toString());
    expect(ce?.meetUrl).toBe(`https://webmail.test/meet/${room?.slug}`);
    expect(ce?.location).toBe(`https://webmail.test/meet/${room?.slug}`);
  });

  it('idempotencia: replay de la misma reserva NO duplica la MeetRoom', async () => {
    const key = 'idem-123';
    const r1 = await createBooking(args({ idempotencyKey: key }));
    const r2 = await createBooking(args({ idempotencyKey: key }));
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.replay).toBe(true);
    expect(r1.booking._id.toString()).toBe(r2.booking._id.toString());
    expect(await MeetRoom.countDocuments({ bookingId: r1.booking._id })).toBe(1);
    expect(await MeetRoom.countDocuments()).toBe(1);
  });

  it('Meet OFF (settings.enabled=false): reserva NO aborta, snapshot SIN video, sin sala', async () => {
    await setMeetSettings({ enabled: false });
    const r = await createBooking(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.booking.snapshot.location.type).toBe('in_person'); // location original, no video
    expect(await MeetRoom.countDocuments()).toBe(0);
  });

  it('tipo SIN meetEnabled: no genera sala aunque Meet esté ON', async () => {
    await EventType.updateOne({ _id: eventType._id }, { $set: { meetEnabled: false } });
    const fresh = await EventType.findById(eventType._id);
    const r = await createBooking(args({ eventType: fresh }));
    expect(r.ok).toBe(true);
    expect(await MeetRoom.countDocuments()).toBe(0);
  });

  it('cancelar la reserva → cierra (soft) la MeetRoom', async () => {
    const r = await createBooking(args());
    if (!r.ok) return;
    await cancelBooking(r.booking, 'invitee');
    const room = await MeetRoom.findOne({ bookingId: r.booking._id });
    expect(room?.status).toBe('closed');
  });

  it('DEGRADADO: si createBookingMeetRoom lanza → la reserva NO se aborta, sin sala, snapshot SIN video', async () => {
    const spy = vi
      .spyOn(bookingMeet, 'createBookingMeetRoom')
      .mockRejectedValueOnce(new Error('mongo blip'));
    const r = await createBooking(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.booking.snapshot.location.type).toBe('in_person'); // location original, no video
    expect(await MeetRoom.countDocuments()).toBe(0); // no se creó sala (lanzó)
    spy.mockRestore();
  });

  it('COMPENSACIÓN: si CalendarEvent.create falla → no queda MeetRoom huérfana', async () => {
    const spy = vi
      .spyOn(CalendarEvent, 'create')
      .mockRejectedValueOnce(new Error('CE boom') as never);
    await expect(createBooking(args())).rejects.toThrow();
    // la sala creada antes del fallo del CE fue compensada (borrada).
    expect(await MeetRoom.countDocuments()).toBe(0);
    expect(await Booking.countDocuments()).toBe(0);
    spy.mockRestore();
  });

  it('reschedule de un booking SIN sala (Meet OFF al crear) → no migra, no falla', async () => {
    await setMeetSettings({ enabled: false });
    const r = await createBooking(args());
    if (!r.ok) return;
    expect(await MeetRoom.countDocuments()).toBe(0);
    await setMeetSettings({
      enabled: true,
      wsUrl: 'wss://meet.test',
      publicBaseUrl: 'https://webmail.test',
    });
    const res = await rescheduleBooking({
      old: r.booking,
      eventType,
      schedule: resolveSchedule({
        timezone: 'America/Bogota',
        weeklyRules: [{ weekday: 1, intervals: [{ start: '09:00', end: '18:00' }] }],
        overrides: [],
      }),
      hostAccountId: accountId,
      newStartAt: new Date('2026-07-06T15:00:00.000Z'),
      now: NOW,
    });
    expect(res.ok).toBe(true);
    expect(await MeetRoom.countDocuments()).toBe(0); // nunca hubo sala → no se inventa una
  });

  const reschedArgs = () => ({
    schedule: resolveSchedule({
      timezone: 'America/Bogota',
      weeklyRules: [{ weekday: 1, intervals: [{ start: '09:00', end: '18:00' }] }],
      overrides: [],
    }),
    eventType,
    hostAccountId: accountId,
    newStartAt: new Date('2026-07-06T15:00:00.000Z'),
    now: NOW,
  });

  it('reschedule: migración COMMIT+timeout → rollback mueve la sala DE VUELTA a old (B-HIGH v2 / R2)', async () => {
    const r = await createBooking(args());
    if (!r.ok) return;
    const room0 = await MeetRoom.findOne({ bookingId: r.booking._id });
    // Simula el caso peligroso (review C v3): el forward migrate COMMITEA server-side (la sala pasa a
    // neo) pero el cliente observa un throw (timeout post-commit). El migrate-back (2ª llamada, impl real)
    // DEBE devolver la sala a old. Si se borrara la línea del migrate-back, este test fallaría.
    const spy = vi
      .spyOn(bookingMeet, 'migrateMeetRoomToBooking')
      .mockImplementationOnce(async (p) => {
        await MeetRoom.updateOne(
          { bookingId: p.fromBookingId },
          { $set: { bookingId: p.toBookingId } } // commit real (room → neo)…
        );
        throw new Error('timeout after commit'); // …pero el cliente ve un throw
      });
    const res = await rescheduleBooking({ old: r.booking, ...reschedArgs() });
    expect(res.ok).toBe(false); // reschedule abortado, no dead-link "exitoso"
    spy.mockRestore();
    const oldAfter = await Booking.findById(r.booking._id);
    expect(oldAfter?.status).toBe('confirmed'); // la vieja sigue válida
    const roomAfter = await MeetRoom.findOne({ slug: room0?.slug });
    expect(roomAfter?.bookingId?.toString()).toBe(r.booking._id.toString()); // sala ROLLED BACK a old
    expect(await MeetRoom.countDocuments()).toBe(1); // sin duplicado
    expect(await Booking.countDocuments({ status: 'confirmed' })).toBe(1); // neo no quedó
  });

  it('reschedule: si la migración devuelve null (sala esfumada) → abortado, old intacto (B-MED v2)', async () => {
    const r = await createBooking(args());
    if (!r.ok) return;
    const spy = vi.spyOn(bookingMeet, 'migrateMeetRoomToBooking').mockResolvedValueOnce(null);
    const res = await rescheduleBooking({ old: r.booking, ...reschedArgs() });
    expect(res.ok).toBe(false);
    spy.mockRestore();
    const oldAfter = await Booking.findById(r.booking._id);
    expect(oldAfter?.status).toBe('confirmed');
    expect(await Booking.countDocuments({ status: 'confirmed' })).toBe(1);
  });

  it('reschedule → nuevo booking hereda la misma URL y la MeetRoom migra (bookingId + expiresAt)', async () => {
    const r = await createBooking(args());
    if (!r.ok) return;
    const room0 = await MeetRoom.findOne({ bookingId: r.booking._id });
    const slug0 = room0?.slug;
    const originalUrl = r.booking.snapshot.location.value;

    const NEW_START = new Date('2026-07-06T15:00:00.000Z'); // mismo día, +1h
    const res = await rescheduleBooking({
      old: r.booking,
      eventType,
      schedule: resolveSchedule({
        timezone: 'America/Bogota',
        weeklyRules: [{ weekday: 1, intervals: [{ start: '09:00', end: '18:00' }] }],
        overrides: [],
      }),
      hostAccountId: accountId,
      newStartAt: NEW_START,
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // El link se preserva (mismo slug/URL heredado del snapshot).
    expect(res.booking.snapshot.location.value).toBe(originalUrl);
    // La sala migró al nuevo booking; el viejo ya no la posee.
    const migrated = await MeetRoom.findOne({ slug: slug0 });
    expect(migrated?.bookingId?.toString()).toBe(res.booking._id.toString());
    expect(migrated?.expiresAt?.getTime()).toBe(res.booking.endAt.getTime() + 30 * 60 * 1000);
    // Sigue habiendo UNA sola sala (no se duplicó).
    expect(await MeetRoom.countDocuments()).toBe(1);
  });
});
