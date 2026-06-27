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

  // Cubre el path del DRAG/RESIZE del calendario (FullCalendar → updateEvent → PATCH parcial):
  // mover un evento sólo manda startDate/endDate y debe persistir, con authz por-usuario.
  it('PATCH actualiza fechas (drag/resize) de forma parcial y owner-bound', async () => {
    const app = await buildTestApp();
    const { user, account } = await seedUserWithAccount({ email: 'drag@test.com' });
    const headers = authHeaders(app, user._id.toString());

    const create = await app.inject({
      method: 'POST',
      url: '/api/calendar',
      headers,
      payload: {
        accountId: account._id.toString(),
        calendarId: 'default',
        calendarName: 'Personal',
        uid: 'uid-drag',
        summary: 'Reunión',
        startDate: '2026-06-10T10:00:00.000Z',
        endDate: '2026-06-10T11:00:00.000Z',
      },
    });
    expect(create.statusCode).toBe(200);
    const id = (JSON.parse(create.body) as { id: string }).id;

    // "Drag": sólo fechas nuevas (PATCH parcial, como manda el front al arrastrar).
    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/${id}`,
      headers,
      payload: { startDate: '2026-06-10T14:00:00.000Z', endDate: '2026-06-10T15:30:00.000Z' },
    });
    expect(moved.statusCode).toBe(200);
    const body = JSON.parse(moved.body) as { summary: string; startDate: string; endDate: string };
    expect(body.summary).toBe('Reunión'); // no se pierden los otros campos
    expect(new Date(body.startDate).toISOString()).toBe('2026-06-10T14:00:00.000Z');
    expect(new Date(body.endDate).toISOString()).toBe('2026-06-10T15:30:00.000Z');

    // Owner-bound: OTRO usuario no puede actualizar el evento (404, no fuga cross-tenant).
    const { user: other } = await seedUserWithAccount({ email: 'other-drag@test.com' });
    const otherHeaders = authHeaders(app, other._id.toString());
    const cross = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/${id}`,
      headers: otherHeaders,
      payload: { startDate: '2026-06-11T10:00:00.000Z', endDate: '2026-06-11T11:00:00.000Z' },
    });
    expect(cross.statusCode).toBe(404);
    await app.close();
  });
});
