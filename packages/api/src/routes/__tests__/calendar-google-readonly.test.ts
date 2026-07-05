import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { CalendarEvent } from '../../models/CalendarEvent.js';

// La feature se fuerza activa para probar el path de tombstone del borrado bidireccional.
vi.mock('../../services/google/creds.js', async (imp) => ({
  ...(await imp<typeof import('../../services/google/creds.js')>()),
  googleEnabled: async () => true,
}));

describe('Calendario: eventos de Google (source:google) read-only + borrado bidireccional (F-gcal BD4)', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => await resetState());

  async function seedGoogleEvent(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<{
    headers: Record<string, string>;
    eventId: string;
  }> {
    const { user, account } = await seedUserWithAccount({ email: 'ro@test.com' });
    const ev = await CalendarEvent.create({
      userId: user._id,
      accountId: account._id,
      calendarId: 'google',
      calendarName: 'Google',
      uid: 'gnative1',
      summary: 'Evento de Google',
      startDate: new Date('2026-08-01T10:00:00Z'),
      endDate: new Date('2026-08-01T11:00:00Z'),
      source: 'google',
      googleEventId: 'gnative1',
    });
    return { headers: authHeaders(app, user._id.toString()), eventId: ev._id.toString() };
  }

  it('PATCH de un evento source:google → 409 (read-only en Bifrost)', async () => {
    const app = await buildTestApp();
    const { headers, eventId } = await seedGoogleEvent(app);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/${eventId}`,
      headers,
      payload: { summary: 'intento de editar' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('GOOGLE_READONLY');
    // No se modificó.
    const doc = await CalendarEvent.findById(eventId);
    expect(doc?.summary).toBe('Evento de Google');
  });

  it('DELETE de un evento source:google → tombstone con googleDeletePending (borra en Google via sync)', async () => {
    const app = await buildTestApp();
    const { headers, eventId } = await seedGoogleEvent(app);
    const res = await app.inject({ method: 'DELETE', url: `/api/calendar/${eventId}`, headers });
    expect(res.statusCode).toBe(200);
    // Queda tombstone (el worker no corre en test): cancelled + deleting + pending → el poller no lo re-crea.
    const doc = await CalendarEvent.findById(eventId);
    expect(doc?.status).toBe('cancelled');
    expect(doc?.googleSyncStatus).toBe('deleting');
    expect(doc?.googleDeletePending).toBe(true);
  });

  it('un evento manual normal SÍ se puede editar (no afecta al resto)', async () => {
    const app = await buildTestApp();
    const { user, account } = await seedUserWithAccount({ email: 'manual@test.com' });
    const ev = await CalendarEvent.create({
      userId: user._id,
      accountId: account._id,
      calendarId: 'c',
      calendarName: 'Personal',
      uid: 'm1',
      summary: 'mío',
      startDate: new Date('2026-08-01T10:00:00Z'),
      endDate: new Date('2026-08-01T11:00:00Z'),
      source: 'manual',
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/${ev._id.toString()}`,
      headers: authHeaders(app, user._id.toString()),
      payload: { summary: 'editado' },
    });
    expect(res.statusCode).toBe(200);
    expect((await CalendarEvent.findById(ev._id))?.summary).toBe('editado');
  });
});
