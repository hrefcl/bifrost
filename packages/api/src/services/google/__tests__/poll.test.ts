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
import { OAuthError } from '../oauth.js';
import { pollUserCalendar, enqueueGooglePolls } from '../poll.js';
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
    vi.mocked(api.listEvents).mockResolvedValueOnce({
      items: [gEvent('a')],
      nextSyncToken: 'tok2',
    });
    await pollUserCalendar(userId);

    expect(api.listEvents).toHaveBeenCalledWith(userId, 'primary', {
      syncToken: 'tok1',
      pageToken: undefined,
    });
    expect(
      await CalendarEvent.countDocuments({ userId, source: 'google', googleEventId: 'a' })
    ).toBe(1);
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
    vi.mocked(api.listEvents).mockResolvedValueOnce({
      items: [gEvent('b')],
      nextSyncToken: 'tokA',
    });
    await pollUserCalendar(userId);

    expect(await CalendarEvent.countDocuments({ userId, googleEventId: 'b' })).toBe(1); // importado
    expect(await CalendarEvent.countDocuments({ userId, googleEventId: 'stale' })).toBe(0); // reconciliado
    expect((await GoogleConnection.findOne({ userId }))?.syncToken).toBe('tokA');
  });

  it('full RECONCILE NO borra un source:google fuera de la ventana [now-30d, now+12m] (review B/D HIGH)', async () => {
    const { userId } = await seedConnected(); // full
    // source:google legítimo a +13 meses (fuera del techo de +12m): el feed windowed no lo trae, pero
    // sigue existiendo en Google → NO debe purgarse.
    const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    await CalendarEvent.create({
      userId,
      accountId: new Types.ObjectId(),
      calendarId: 'google',
      calendarName: 'Google',
      uid: 'faraway',
      summary: 'lejano',
      startDate: farFuture,
      endDate: new Date(farFuture.getTime() + 3600000),
      source: 'google',
      googleEventId: 'faraway',
    });
    vi.mocked(api.listEvents).mockResolvedValueOnce({
      items: [gEvent('x')],
      nextSyncToken: 'tokX',
    });
    await pollUserCalendar(userId);

    expect(await CalendarEvent.countDocuments({ userId, googleEventId: 'faraway' })).toBe(1); // sobrevive
    expect(await CalendarEvent.countDocuments({ userId, googleEventId: 'x' })).toBe(1); // importado
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

  it('401 permanente de la API (acceso revocado) → marca conn en error y NO se re-encola (anti-martilleo)', async () => {
    const { userId } = await seedConnected('tokZ');
    vi.mocked(api.listEvents).mockRejectedValueOnce(new OAuthError('401', true));
    await expect(pollUserCalendar(userId)).rejects.toBeInstanceOf(OAuthError); // el job falla (observabilidad)

    const conn = await GoogleConnection.findOne({ userId });
    expect(conn?.status).toBe('error'); // cortó el martilleo
    // enqueueGooglePolls filtra por status:'connected' → este usuario ya no se encola.
    expect(await enqueueGooglePolls(false)).toBe(0);
  });

  it('carrera stale-poll vs reconnect: si la conexión cambió (updatedAt) NO se pisa con error (CAS, review B)', async () => {
    const { userId } = await seedConnected('tokR');
    // Simula: el poll falla con 401, pero el usuario YA reconectó (updatedAt avanzó) antes del updateOne.
    vi.mocked(api.listEvents).mockImplementationOnce(async () => {
      await GoogleConnection.updateOne(
        { userId },
        {
          $set: {
            status: 'connected',
            syncToken: 'fresh',
            updatedAt: new Date(Date.now() + 60_000),
          },
        },
        { timestamps: false }
      );
      throw new OAuthError('401', true);
    });
    await expect(pollUserCalendar(userId)).rejects.toBeInstanceOf(OAuthError);
    // La conexión reconectada sigue sana: el CAS por updatedAt evitó pisarla.
    expect((await GoogleConnection.findOne({ userId }))?.status).toBe('connected');
  });

  it('error TRANSITORIO (5xx) → NO marca la conexión en error (BullMQ reintenta)', async () => {
    const { userId } = await seedConnected('tokT');
    vi.mocked(api.listEvents).mockRejectedValueOnce(new api.GoogleApiError('Google API 503', 503));
    await expect(pollUserCalendar(userId)).rejects.toBeTruthy();
    expect((await GoogleConnection.findOne({ userId }))?.status).toBe('connected'); // intacta
  });

  it('post-guard: si el usuario DESCONECTÓ mientras el poll importaba, purga los imports (carrera, review B)', async () => {
    const { userId } = await seedConnected('tokPG');
    // El feed trae un evento, pero DURANTE el import el usuario desconecta (status→revoked, generation++).
    vi.mocked(api.listEvents).mockImplementationOnce(async () => {
      await GoogleConnection.updateOne(
        { userId },
        { $set: { status: 'revoked' }, $inc: { generation: 1 } }
      );
      return { items: [gEvent('pg')], nextSyncToken: 'tokPG2' };
    });
    await pollUserCalendar(userId);
    // El post-guard detecta el cambio de generación y purga lo que el poll importó → cero huérfanos.
    expect(await CalendarEvent.countDocuments({ userId, source: 'google' })).toBe(0);
  });

  it('post-guard con disconnect+RECONNECT rápido (status vuelve a connected): la generación NO retrocede → purga (review B)', async () => {
    const { userId } = await seedConnected('tokRR');
    // Durante el import: disconnect (gen++) y reconnect inmediato (gen++). status queda 'connected' otra vez,
    // pero la generación avanzó 2 → los imports del poll VIEJO deben purgarse igual.
    vi.mocked(api.listEvents).mockImplementationOnce(async () => {
      await GoogleConnection.updateOne(
        { userId },
        { $set: { status: 'connected' }, $inc: { generation: 2 } }
      );
      return { items: [gEvent('rr')], nextSyncToken: 'tokRR2' };
    });
    await pollUserCalendar(userId);
    expect(await CalendarEvent.countDocuments({ userId, source: 'google' })).toBe(0);
  });

  it('conexión NO conectada → no llama a Google', async () => {
    const { user } = await seedUserWithAccount({ email: 'off@test.com' });
    await GoogleConnection.create({
      userId: user._id,
      status: 'error',
      googleCalendarId: 'primary',
    });
    await pollUserCalendar(user._id);
    expect(api.listEvents).not.toHaveBeenCalled();
  });
});
