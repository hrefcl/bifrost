import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { setupTestDb, teardownTestDb, resetState } from '../../../../test/integration-helper.js';

// La feature se fuerza activa; las llamadas de red a Google se mockean.
vi.mock('../../../config/env.js', async (imp) => {
  const actual = await imp<typeof import('../../../config/env.js')>();
  return { ...actual, googleConfigured: () => true };
});
vi.mock('../calendar-api.js', () => ({
  upsertEvent: vi.fn(async () => undefined),
  deleteEvent: vi.fn(async () => undefined),
}));

import * as api from '../calendar-api.js';
import { syncEventToGoogle, googleEventIdFor } from '../sync.js';
import { CalendarEvent, type ICalendarEvent } from '../../../models/CalendarEvent.js';
import { GoogleConnection } from '../../../models/GoogleConnection.js';
import { encrypt } from '../../../config/crypto.js';

async function connect(userId: Types.ObjectId): Promise<void> {
  await GoogleConnection.create({
    userId,
    accessTokenEnc: encrypt('a'),
    refreshTokenEnc: encrypt('r'),
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    status: 'connected',
    googleCalendarId: 'primary',
  });
}

let uidSeq = 0;
async function makeEvent(
  userId: Types.ObjectId,
  over: Partial<ICalendarEvent> = {}
): Promise<ICalendarEvent> {
  return CalendarEvent.create({
    userId,
    accountId: new Types.ObjectId(),
    calendarId: 'c',
    calendarName: 'C',
    uid: `u${String(++uidSeq)}`,
    summary: 'Reunión',
    startDate: new Date('2026-07-01T10:00:00Z'),
    endDate: new Date('2026-07-01T11:00:00Z'),
    ...over,
  });
}

describe('syncEventToGoogle (F-gcal G3)', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => {
    await resetState();
    vi.clearAllMocks();
  });

  it('evento normal → upsert idempotente + status synced + googleEventId determinista', async () => {
    const userId = new Types.ObjectId();
    await connect(userId);
    const ev = await makeEvent(userId);
    await syncEventToGoogle(ev._id.toString());

    expect(api.upsertEvent).toHaveBeenCalledOnce();
    const [uid, calId, resource] = vi.mocked(api.upsertEvent).mock.calls[0];
    expect(String(uid)).toBe(userId.toString());
    expect(calId).toBe('primary');
    expect(resource.id).toBe(googleEventIdFor(ev._id)); // id derivado del _id (sin duplicados)
    expect(resource.summary).toBe('Reunión');

    const fresh = await CalendarEvent.findById(ev._id);
    expect(fresh?.googleSyncStatus).toBe('synced');
    expect(fresh?.googleEventId).toBe(googleEventIdFor(ev._id));
    expect(fresh?.googleLastSyncedAt).toBeInstanceOf(Date);
  });

  it('tombstone (cancelled) → delete en Google y elimina el doc local', async () => {
    const userId = new Types.ObjectId();
    await connect(userId);
    const ev = await makeEvent(userId, {
      status: 'cancelled',
      googleSyncStatus: 'deleting',
      googleEventId: 'bifexisting',
    });
    await syncEventToGoogle(ev._id.toString());

    expect(api.deleteEvent).toHaveBeenCalledOnce();
    expect(await CalendarEvent.findById(ev._id)).toBeNull(); // tombstone limpiado tras confirmar Google
  });

  it('sin conexión Google → status skipped, no llama a la API', async () => {
    const userId = new Types.ObjectId(); // sin GoogleConnection
    const ev = await makeEvent(userId);
    await syncEventToGoogle(ev._id.toString());

    expect(api.upsertEvent).not.toHaveBeenCalled();
    const fresh = await CalendarEvent.findById(ev._id);
    expect(fresh?.googleSyncStatus).toBe('skipped');
  });

  it('CAS: si el evento cambia DURANTE el upsert, el job no pisa el estado nuevo', async () => {
    const userId = new Types.ObjectId();
    await connect(userId);
    const ev = await makeEvent(userId, { googleSyncStatus: 'pending' });
    // Simula una edición concurrente mientras el job habla con Google: bumpea updatedAt → el mark
    // terminal (CAS sobre updatedAt) NO debe pisar el 'pending' recién puesto.
    vi.mocked(api.upsertEvent).mockImplementationOnce(async () => {
      await CalendarEvent.updateOne(
        { _id: ev._id },
        { $set: { summary: 'editado', googleSyncStatus: 'pending' } }
      );
    });
    await syncEventToGoogle(ev._id.toString());
    const fresh = await CalendarEvent.findById(ev._id);
    expect(fresh?.googleSyncStatus).toBe('pending'); // CAS evitó marcar 'synced' sobre el estado nuevo
  });

  it('conexión en error (refresh revocado) → NO llama a Google, marca skipped (sin martilleo)', async () => {
    const userId = new Types.ObjectId();
    await GoogleConnection.create({ userId, status: 'error', googleCalendarId: 'primary' });
    const ev = await makeEvent(userId);
    await syncEventToGoogle(ev._id.toString());
    expect(api.upsertEvent).not.toHaveBeenCalled();
    expect(api.deleteEvent).not.toHaveBeenCalled();
    const fresh = await CalendarEvent.findById(ev._id);
    expect(fresh?.googleSyncStatus).toBe('skipped');
  });

  it('fallo de la API → status error + re-lanza (para que BullMQ reintente)', async () => {
    const userId = new Types.ObjectId();
    await connect(userId);
    const ev = await makeEvent(userId);
    vi.mocked(api.upsertEvent).mockRejectedValueOnce(new Error('boom'));

    await expect(syncEventToGoogle(ev._id.toString())).rejects.toThrow('boom');
    const fresh = await CalendarEvent.findById(ev._id);
    expect(fresh?.googleSyncStatus).toBe('error');
    expect(fresh?.googleSyncError).toContain('boom');
  });
});
