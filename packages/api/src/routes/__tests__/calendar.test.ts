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

  // Cubre el path del MODAL DE EDICIÓN del calendario (click en evento → Editar → PATCH con
  // summary + fechas + allDay juntos), distinto del drag que sólo manda fechas.
  it('PATCH edita summary + allDay + fechas a la vez (modal de edición) y es owner-bound', async () => {
    const app = await buildTestApp();
    const { user, account } = await seedUserWithAccount({ email: 'edit@test.com' });
    const headers = authHeaders(app, user._id.toString());

    const create = await app.inject({
      method: 'POST',
      url: '/api/calendar',
      headers,
      payload: {
        accountId: account._id.toString(),
        calendarId: 'default',
        calendarName: 'Personal',
        uid: 'uid-edit',
        summary: 'Borrador',
        startDate: '2026-06-12T09:00:00.000Z',
        endDate: '2026-06-12T10:00:00.000Z',
        allDay: false,
      },
    });
    expect(create.statusCode).toBe(200);
    const id = (JSON.parse(create.body) as { id: string }).id;

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/${id}`,
      headers,
      payload: {
        summary: 'Reunión confirmada',
        startDate: '2026-06-12T00:00:00.000Z',
        endDate: '2026-06-12T23:59:59.999Z',
        allDay: true,
      },
    });
    expect(edited.statusCode).toBe(200);
    const body = JSON.parse(edited.body) as { summary: string; allDay: boolean; startDate: string };
    expect(body.summary).toBe('Reunión confirmada');
    expect(body.allDay).toBe(true);
    expect(new Date(body.startDate).toISOString()).toBe('2026-06-12T00:00:00.000Z');

    // Editar con rango inválido (fin <= inicio) → 400, no corrompe el evento.
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/${id}`,
      headers,
      payload: {
        summary: 'X',
        startDate: '2026-06-12T10:00:00.000Z',
        endDate: '2026-06-12T09:00:00.000Z',
      },
    });
    expect(bad.statusCode).toBe(400);

    // PATCH PARCIAL inválido contra la fecha EXISTENTE: el evento quedó 00:00→23:59 (allDay). Mandar
    // sólo endDate ANTERIOR al startDate existente debe dar 400 (no sólo cuando llegan ambas) —
    // review B: el endpoint protege su invariante aunque la otra fecha no venga en el body.
    const partialBad = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/${id}`,
      headers,
      payload: { endDate: '2026-06-11T00:00:00.000Z' }, // antes del start existente (2026-06-12 00:00)
    });
    expect(partialBad.statusCode).toBe(400);
    await app.close();
  });

  // Campos description/location del modal: el backend ya los soportaba (schema + serializer); este
  // test fija el round-trip crear → editar → limpiar, owner-bound implícito por userId.
  it('persiste description y location en create y edit; permite limpiarlos', async () => {
    const app = await buildTestApp();
    const { user, account } = await seedUserWithAccount({ email: 'descloc@test.com' });
    const headers = authHeaders(app, user._id.toString());

    const create = await app.inject({
      method: 'POST',
      url: '/api/calendar',
      headers,
      payload: {
        accountId: account._id.toString(),
        calendarId: 'default',
        calendarName: 'Personal',
        uid: 'uid-descloc',
        summary: 'Almuerzo',
        description: 'Repasar el roadmap del Q3',
        location: 'Café Central, Av. Siempreviva 742',
        startDate: '2026-06-13T12:00:00.000Z',
        endDate: '2026-06-13T13:00:00.000Z',
      },
    });
    expect(create.statusCode).toBe(200);
    const created = JSON.parse(create.body) as {
      id: string;
      description?: string;
      location?: string;
    };
    expect(created.description).toBe('Repasar el roadmap del Q3');
    expect(created.location).toBe('Café Central, Av. Siempreviva 742');

    // Editar ambos.
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/${created.id}`,
      headers,
      payload: { description: 'Cambió a planning anual', location: 'Sala 3' },
    });
    expect(edited.statusCode).toBe(200);
    const after = JSON.parse(edited.body) as { description?: string; location?: string };
    expect(after.description).toBe('Cambió a planning anual');
    expect(after.location).toBe('Sala 3');

    // Limpiar (string vacío) → quedan vacíos.
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/${created.id}`,
      headers,
      payload: { description: '', location: '' },
    });
    expect(cleared.statusCode).toBe(200);
    const blank = JSON.parse(cleared.body) as { description?: string; location?: string };
    expect(blank.description ?? '').toBe('');
    expect(blank.location ?? '').toBe('');
    await app.close();
  });
});
