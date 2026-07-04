import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { setupTestDb, teardownTestDb, resetState } from '../../../../test/integration-helper.js';

// Feature activa; el enqueue real (BullMQ) se mockea para observar A QUIÉNES re-encola el backstop.
vi.mock('../../google/creds.js', async (imp) => {
  const actual = await imp<typeof import('../../google/creds.js')>();
  return { ...actual, googleEnabled: async () => true };
});
vi.mock('../../google/dispatch.js', () => ({
  enqueueGoogleSync: vi.fn(async () => undefined),
}));

import * as dispatch from '../../google/dispatch.js';
import { runReconcile } from '../reconciler.js';
import { CalendarEvent } from '../../../models/CalendarEvent.js';
import { GoogleConnection } from '../../../models/GoogleConnection.js';

let uidSeq = 0;
/** Crea un evento "atascado" (pending) con updatedAt viejo (> GRACE) para que el backstop lo tome. */
async function stuckEvent(userId: Types.ObjectId): Promise<Types.ObjectId> {
  const ev = await CalendarEvent.create({
    userId,
    accountId: new Types.ObjectId(),
    calendarId: 'c',
    calendarName: 'C',
    uid: `rg${String(++uidSeq)}`,
    summary: 'x',
    startDate: new Date('2026-07-01T10:00:00Z'),
    endDate: new Date('2026-07-01T11:00:00Z'),
    googleSyncStatus: 'pending',
  });
  // Backdate updatedAt por el driver crudo (evita el auto-bump de timestamps de mongoose).
  await CalendarEvent.collection.updateOne(
    { _id: ev._id },
    { $set: { updatedAt: new Date(Date.now() - 120_000) } }
  );
  return ev._id;
}

describe('reconciler backstop gcal (F-gcal) — sólo usuarios con conexión activa', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => {
    await resetState();
    vi.clearAllMocks();
  });

  it('re-encola los eventos atascados del usuario CONECTADO y NO los del que está en error', async () => {
    const connectedUser = new Types.ObjectId();
    const errorUser = new Types.ObjectId();
    await GoogleConnection.create({
      userId: connectedUser,
      status: 'connected',
      googleCalendarId: 'primary',
    });
    await GoogleConnection.create({
      userId: errorUser,
      status: 'error',
      googleCalendarId: 'primary',
    });
    const connectedEventId = await stuckEvent(connectedUser);
    await stuckEvent(errorUser); // NO debe re-encolarse (churn evitado)

    const res = await runReconcile();

    const enqueued = vi.mocked(dispatch.enqueueGoogleSync).mock.calls.map((c) => String(c[0]));
    expect(enqueued).toEqual([connectedEventId.toString()]);
    expect(res.gcalRequeued).toBe(1);
  });

  it('sin ninguna conexión activa → no re-encola nada (sin churn)', async () => {
    const errorUser = new Types.ObjectId();
    await GoogleConnection.create({
      userId: errorUser,
      status: 'error',
      googleCalendarId: 'primary',
    });
    await stuckEvent(errorUser);

    const res = await runReconcile();

    expect(dispatch.enqueueGoogleSync).not.toHaveBeenCalled();
    expect(res.gcalRequeued).toBe(0);
  });
});
