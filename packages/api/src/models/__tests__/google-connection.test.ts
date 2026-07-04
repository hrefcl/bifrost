import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { setupTestDb, teardownTestDb, resetState } from '../../../test/integration-helper.js';
import {
  GoogleConnection,
  toGoogleConnectionStatus,
  type IGoogleConnection,
} from '../GoogleConnection.js';
import { encrypt } from '../../config/crypto.js';

describe('GoogleConnection (F-gcal G1)', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => await resetState());

  it('guarda tokens CIFRADOS y una sola conexión por usuario (unique)', async () => {
    const userId = new Types.ObjectId();
    await GoogleConnection.create({
      userId,
      accessTokenEnc: encrypt('access-secret'),
      refreshTokenEnc: encrypt('refresh-secret'),
      googleUserEmail: 'ana@gmail.com',
      status: 'connected',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      scope: 'https://www.googleapis.com/auth/calendar.events',
    });
    // El token guardado NO es texto plano (está cifrado: ciphertext/iv/tag).
    const doc = await GoogleConnection.findOne({ userId }).lean<IGoogleConnection>();
    expect(doc?.accessTokenEnc?.ciphertext).toBeTruthy();
    expect(JSON.stringify(doc)).not.toContain('access-secret');
    expect(JSON.stringify(doc)).not.toContain('refresh-secret');
    // Unicidad: segunda conexión del mismo user → E11000.
    await expect(GoogleConnection.create({ userId, status: 'connected' })).rejects.toThrow();
  });

  it('toGoogleConnectionStatus NUNCA expone tokens ni datos sensibles', async () => {
    const doc = await GoogleConnection.create({
      userId: new Types.ObjectId(),
      accessTokenEnc: encrypt('access-secret'),
      refreshTokenEnc: encrypt('refresh-secret'),
      googleUserEmail: 'ana@gmail.com',
      status: 'connected',
      lastSyncedAt: new Date(),
    });
    const status = toGoogleConnectionStatus(doc);
    const json = JSON.stringify(status);
    expect(json).not.toContain('access-secret');
    expect(json).not.toContain('refresh-secret');
    expect(json).not.toMatch(/ciphertext|refreshToken|accessToken/i);
    expect(status.connected).toBe(true);
    expect(status.email).toBe('ana@gmail.com');
    expect(status.calendarId).toBe('primary');
  });

  it('status de una conexión ausente = desconectado', () => {
    const status = toGoogleConnectionStatus(null);
    expect(status.connected).toBe(false);
    expect(status.email).toBeNull();
  });

  it('desconexión soft: status revoked + tokens unset (queda histórico)', async () => {
    const userId = new Types.ObjectId();
    const doc = await GoogleConnection.create({
      userId,
      accessTokenEnc: encrypt('a'),
      refreshTokenEnc: encrypt('r'),
      status: 'connected',
    });
    await GoogleConnection.updateOne(
      { _id: doc._id },
      { $set: { status: 'revoked' }, $unset: { accessTokenEnc: '', refreshTokenEnc: '' } }
    );
    const fresh = await GoogleConnection.findOne({ userId }).lean<IGoogleConnection>();
    expect(fresh?.status).toBe('revoked');
    expect(fresh?.accessTokenEnc).toBeUndefined();
    expect(fresh?.refreshTokenEnc).toBeUndefined();
    expect(toGoogleConnectionStatus(fresh).connected).toBe(false);
  });
});
