import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';

/**
 * Regresión del FILTRO DE RANGO del calendario (review B del rebuild UI).
 *
 * El filtro original sólo pedía `startDate` DENTRO del rango → un evento que empieza ANTES del
 * rango pero termina DENTRO quedaba afuera (perdido). Debe usar solapamiento real:
 * `startDate <= end AND endDate >= start`.
 */
describe('GET /api/calendar — filtro de rango por solapamiento', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('incluye eventos que CRUZAN el borde del rango, excluye los de afuera', async () => {
    const app = await buildTestApp();
    const { user, account } = await seedUserWithAccount({ email: 'cal@test.com' });
    const headers = authHeaders(app, user._id.toString());

    const makeEvent = (summary: string, startDate: string, endDate: string) => ({
      accountId: account._id.toString(),
      calendarId: 'default',
      calendarName: 'Personal',
      uid: `uid-${summary}`,
      summary,
      startDate,
      endDate,
    });

    // Rango de consulta: junio 2026.
    const rangeStart = '2026-06-01T00:00:00.000Z';
    const rangeEnd = '2026-06-30T23:59:59.999Z';

    const events = [
      // empieza ANTES del rango, termina DENTRO → el filtro viejo lo perdía (la regresión).
      makeEvent('cruza-inicio', '2026-05-30T10:00:00.000Z', '2026-06-02T10:00:00.000Z'),
      // completamente dentro.
      makeEvent('dentro', '2026-06-15T10:00:00.000Z', '2026-06-15T11:00:00.000Z'),
      // completamente fuera (mes siguiente) → debe excluirse.
      makeEvent('fuera', '2026-07-05T10:00:00.000Z', '2026-07-05T11:00:00.000Z'),
    ];
    for (const ev of events) {
      const res = await app.inject({ method: 'POST', url: '/api/calendar', headers, payload: ev });
      expect(res.statusCode, `crear ${ev.summary}`).toBe(200);
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/calendar?start=${rangeStart}&end=${rangeEnd}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const got = (JSON.parse(res.body) as Array<{ summary: string }>).map((e) => e.summary).sort();

    expect(got).toEqual(['cruza-inicio', 'dentro']); // 'fuera' excluido; 'cruza-inicio' incluido
    await app.close();
  });
});
