import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { setupTestDb, teardownTestDb, resetState } from '../../../../test/integration-helper.js';
import { CalendarEvent } from '../../../models/CalendarEvent.js';
import { applyGoogleEvent } from '../import.js';
import type { GoogleEventRead } from '../calendar-api.js';

function gEvent(over: Partial<GoogleEventRead> = {}): GoogleEventRead {
  return {
    id: 'gid-' + (over.id ?? Math.random().toString(36).slice(2)),
    status: 'confirmed',
    summary: 'Reunión Google',
    start: { dateTime: '2026-08-01T10:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-08-01T11:00:00Z', timeZone: 'UTC' },
    eventType: 'default',
    ...over,
  };
}

describe('applyGoogleEvent — motor de import bidireccional (F-gcal BD2)', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => await resetState());

  const userId = new Types.ObjectId();
  const accountId = new Types.ObjectId();

  it('evento normal → import como source:google en el calendario "Google"', async () => {
    const ev = gEvent({ id: 'g1' });
    expect(await applyGoogleEvent(userId, accountId, ev)).toBe('imported');
    const doc = await CalendarEvent.findOne({ userId, googleEventId: ev.id });
    expect(doc?.source).toBe('google');
    expect(doc?.calendarName).toBe('Google');
    expect(doc?.summary).toBe('Reunión Google');
  });

  it('upsert idempotente: aplicar dos veces → 1 solo evento, actualizado', async () => {
    const ev = gEvent({ id: 'g2', summary: 'v1' });
    await applyGoogleEvent(userId, accountId, ev);
    await applyGoogleEvent(userId, accountId, { ...ev, summary: 'v2' });
    const docs = await CalendarEvent.find({ userId, googleEventId: ev.id });
    expect(docs).toHaveLength(1);
    expect(docs[0].summary).toBe('v2');
  });

  it('anti-loop capa 1: evento con bifrostOrigin → skipped (no importa)', async () => {
    const ev = gEvent({ id: 'g3', extendedProperties: { private: { bifrostOrigin: '1' } } });
    expect(await applyGoogleEvent(userId, accountId, ev)).toBe('skipped');
    expect(await CalendarEvent.countDocuments({ userId, googleEventId: ev.id })).toBe(0);
  });

  it('anti-loop capa 2: si ya existe un Bifrost-origen con ese googleEventId → skipped', async () => {
    await CalendarEvent.create({
      userId,
      accountId,
      calendarId: 'c',
      calendarName: 'Personal',
      uid: 'u-manual',
      summary: 'mío',
      startDate: new Date(),
      endDate: new Date(Date.now() + 3600000),
      source: 'manual',
      googleEventId: 'g4',
    });
    expect(await applyGoogleEvent(userId, accountId, gEvent({ id: 'g4' }))).toBe('skipped');
    // No se creó un segundo doc source:google.
    expect(await CalendarEvent.countDocuments({ googleEventId: 'gid-g4' })).toBe(0);
  });

  it('eventType especial (birthday) → ignored', async () => {
    expect(await applyGoogleEvent(userId, accountId, gEvent({ id: 'g5', eventType: 'birthday' }))).toBe(
      'ignored'
    );
    expect(await CalendarEvent.countDocuments({ userId, source: 'google' })).toBe(0);
  });

  it('status cancelled → borra el import local', async () => {
    const ev = gEvent({ id: 'g6' });
    await applyGoogleEvent(userId, accountId, ev);
    expect(await CalendarEvent.countDocuments({ userId, googleEventId: ev.id })).toBe(1);
    expect(await applyGoogleEvent(userId, accountId, { ...ev, status: 'cancelled' })).toBe('deleted');
    expect(await CalendarEvent.countDocuments({ userId, googleEventId: ev.id })).toBe(0);
  });

  it('tombstone de borrado bidireccional (googleDeletePending) → NO se re-crea', async () => {
    const ev = gEvent({ id: 'g7' });
    await applyGoogleEvent(userId, accountId, ev);
    await CalendarEvent.updateOne(
      { userId, googleEventId: ev.id, source: 'google' },
      { $set: { googleDeletePending: true, status: 'cancelled' } }
    );
    // Un update del feed no debe resucitarlo mientras el borrado remoto está pendiente.
    expect(await applyGoogleEvent(userId, accountId, { ...ev, summary: 'resucita?' })).toBe('skipped');
    const doc = await CalendarEvent.findOne({ userId, googleEventId: ev.id });
    expect(doc?.googleDeletePending).toBe(true);
    expect(doc?.summary).not.toBe('resucita?');
  });

  it('all-day (start.date) → allDay true', async () => {
    const ev = gEvent({ id: 'g8', start: { date: '2026-08-05' }, end: { date: '2026-08-06' } });
    await applyGoogleEvent(userId, accountId, ev);
    const doc = await CalendarEvent.findOne({ userId, googleEventId: ev.id });
    expect(doc?.allDay).toBe(true);
  });
});
