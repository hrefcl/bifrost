import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  seedUserWithAccount,
} from '../../../../test/integration-helper.js';

vi.mock('../creds.js', async (imp) => ({
  ...(await imp<typeof import('../creds.js')>()),
  googleEnabled: async () => true,
}));
vi.mock('../calendar-api.js', async (imp) => {
  const actual = await imp<typeof import('../calendar-api.js')>();
  return { ...actual, listEvents: vi.fn() };
});

import * as api from '../calendar-api.js';
import type { GoogleEventRead } from '../calendar-api.js';
import { pollUserCalendar } from '../poll.js';
import { GoogleConnection } from '../../../models/GoogleConnection.js';
import { Account } from '../../../models/Account.js';
import { CalendarEvent } from '../../../models/CalendarEvent.js';

function gEvent(id: string, over: Partial<GoogleEventRead> = {}): GoogleEventRead {
  return {
    id,
    status: 'confirmed',
    summary: 'G ' + id,
    start: { dateTime: '2026-08-01T10:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-08-01T11:00:00Z', timeZone: 'UTC' },
    eventType: 'default',
    ...over,
  };
}

describe('pollUserCalendar — poller bidireccional (F-gcal BD3)', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => {
    await resetState();
    vi.clearAllMocks();
  });

  async function seedConnected(syncToken?: string): Promise<{ userId: Types.ObjectId }> {
    const { user, account } = await seedUserWithAccount({ email: 'poll@test.com' });
    await Account.updateOne({ _id: account._id }, { $set: { isPrimary: true } });
    await GoogleConnection.create({
      userId: user._id,
      status: 'connected',
      googleCalendarId: 'primary',
      syncToken,
    });
    return { userId: user._id };
  }

  it('incremental: usa el syncToken, importa el delta y guarda el nextSyncToken', async () => {
    const { userId } = await seedConnected('tok1');
    vi.mocked(api.listEvents).mockResolvedValueOnce({ items: [gEvent('a')], nextSyncToken: 'tok2' });
    await pollUserCalendar(userId);

    expect(api.listEvents).toHaveBeenCalledWith(userId, 'primary', {
      syncToken: 'tok1',
      pageToken: undefined,
    });
    expect(await CalendarEvent.countDocuments({ userId, source: 'google', googleEventId: 'a' })).toBe(1);
    expect((await GoogleConnection.findOne({ userId }))?.syncToken).toBe('tok2');
  });

  it('full (sin token): importa la ventana y RECONCILE borra los locales que ya no están en el feed', async () => {
    const { userId } = await seedConnected(); // sin syncToken → full
    // Pre-siembro un source:google "stale" que YA no vendrá en el feed → debe borrarse.
    await CalendarEvent.create({
      userId,
      accountId: new Types.ObjectId(),
      calendarId: 'google',
      calendarName: 'Google',
      uid: 'stale',
      summary: 'viejo',
      startDate: new Date(),
      endDate: new Date(Date.now() + 3600000),
      source: 'google',
      googleEventId: 'stale',
    });
    vi.mocked(api.listEvents).mockResolvedValueOnce({ items: [gEvent('b')], nextSyncToken: 'tokA' });
    await pollUserCalendar(userId);

    expect(await CalendarEvent.countDocuments({ userId, googleEventId: 'b' })).toBe(1); // importado
    expect(await CalendarEvent.countDocuments({ userId, googleEventId: 'stale' })).toBe(0); // reconciliado
    expect((await GoogleConnection.findOne({ userId }))?.syncToken).toBe('tokA');
  });

  it('410 (syncToken vencido) → cae a full re-sync', async () => {
    const { userId } = await seedConnected('expired');
    vi.mocked(api.listEvents).mockImplementation(async (_u, _c, opts) => {
      if (opts.syncToken) throw new api.GoogleSyncTokenExpired(); // el incremental 410
      return { items: [gEvent('c')], nextSyncToken: 'tokFull' }; // el full posterior
    });
    await pollUserCalendar(userId);

    expect(await CalendarEvent.countDocuments({ userId, googleEventId: 'c' })).toBe(1);
    expect((await GoogleConnection.findOne({ userId }))?.syncToken).toBe('tokFull');
  });

  it('conexión NO conectada → no llama a Google', async () => {
    const { user } = await seedUserWithAccount({ email: 'off@test.com' });
    await GoogleConnection.create({ userId: user._id, status: 'error', googleCalendarId: 'primary' });
    await pollUserCalendar(user._id);
    expect(api.listEvents).not.toHaveBeenCalled();
  });
});
