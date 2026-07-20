import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Tests del janitor de salas de Meet: el auto-cierre de la sala que quedó con UN participante colgado
 * (pestaña olvidada). Es el caso que `empty_timeout` de LiveKit NO cubre — la sala no está vacía.
 */

// `vi.mock` se hoistea por encima de los `const` del módulo → los dobles deben crearse con `vi.hoisted`.
const h = vi.hoisted(() => ({
  listRooms: vi.fn(),
  deleteRoom: vi.fn(),
  updateMany: vi.fn(),
  updateOne: vi.fn(),
  storedSettings: vi.fn(),
  foundDocs: [] as { slug: string; soloSince?: Date }[],
}));
const { listRooms, deleteRoom, updateMany, updateOne, storedSettings } = h;

vi.mock('livekit-server-sdk', () => {
  class RoomServiceClient {
    constructor(_h: string, _k?: string, _s?: string) {}
    listRooms = h.listRooms;
    deleteRoom = h.deleteRoom;
  }
  // `AccessToken` no lo usa el janitor, pero el mock reemplaza el módulo entero y token-service lo importa.
  class AccessToken {
    addGrant(_g: unknown): void {}
    toJwt(): Promise<string> {
      return Promise.resolve('tok');
    }
  }
  return { RoomServiceClient, AccessToken };
});

vi.mock('../../../models/MeetRoom.js', () => ({
  MeetRoom: {
    updateMany: h.updateMany,
    updateOne: h.updateOne,
    find: () => ({ select: () => ({ lean: () => Promise.resolve(h.foundDocs) }) }),
  },
}));

vi.mock('../settings.js', () => ({ getStoredMeetSettings: () => h.storedSettings() }));

import { runMeetJanitor, markMeetRoomAlive, SOLO_MAX_MS } from '../janitor.js';

const ENABLED = {
  enabled: true,
  wsUrl: 'wss://meet.test',
  publicBaseUrl: 'https://webmail.test',
  maxParticipants: 20,
  maxDurationMinutes: 240,
  allowExternal: true,
  auditEnabled: true,
};

const NOW = new Date('2026-07-20T12:00:00Z').getTime();
const room = (name: string, numParticipants: number) => ({ name, numParticipants });

beforeEach(() => {
  vi.clearAllMocks();
  h.foundDocs = [];
  storedSettings.mockResolvedValue({ ...ENABLED });
  updateMany.mockResolvedValue({});
  updateOne.mockResolvedValue({});
  process.env.LIVEKIT_API_KEY = 'k';
  process.env.LIVEKIT_API_SECRET = 's';
});

describe('runMeetJanitor', () => {
  it('no hace nada si Meet está apagado (ni siquiera consulta LiveKit)', async () => {
    storedSettings.mockResolvedValue({ ...ENABLED, enabled: false });
    const r = await runMeetJanitor(NOW);
    expect(r).toEqual({ seen: 0, closed: 0 });
    expect(listRooms).not.toHaveBeenCalled();
  });

  it('marca soloSince la PRIMERA vez que ve una sala con un solo participante, sin cerrarla', async () => {
    listRooms.mockResolvedValue([room('sala-uno', 1)]);
    h.foundDocs = [{ slug: 'sala-uno' }]; // sin marca previa
    const r = await runMeetJanitor(NOW);
    expect(r.closed).toBe(0);
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      { slug: { $in: ['sala-uno'] } },
      { $set: { soloSince: new Date(NOW) } }
    );
  });

  it('NO cierra si lleva sola menos del umbral', async () => {
    listRooms.mockResolvedValue([room('sala-uno', 1)]);
    h.foundDocs = [{ slug: 'sala-uno', soloSince: new Date(NOW - SOLO_MAX_MS + 60_000) }];
    const r = await runMeetJanitor(NOW);
    expect(r.closed).toBe(0);
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it('cierra la sala que lleva sola MÁS del umbral y limpia la marca', async () => {
    listRooms.mockResolvedValue([room('zombie', 1)]);
    h.foundDocs = [{ slug: 'zombie', soloSince: new Date(NOW - SOLO_MAX_MS - 1000) }];
    const r = await runMeetJanitor(NOW);
    expect(r.closed).toBe(1);
    expect(deleteRoom).toHaveBeenCalledWith('zombie');
    expect(updateMany).toHaveBeenCalledWith(
      { slug: { $in: ['zombie'] } },
      { $unset: { soloSince: '' } }
    );
  });

  it('el caso reportado: la sala olvidada hace DOS DÍAS se cierra', async () => {
    listRooms.mockResolvedValue([room('olvidada', 1)]);
    h.foundDocs = [{ slug: 'olvidada', soloSince: new Date(NOW - 2 * 24 * 3600 * 1000) }];
    expect((await runMeetJanitor(NOW)).closed).toBe(1);
    expect(deleteRoom).toHaveBeenCalledWith('olvidada');
  });

  it('limpia la marca (y no cierra) cuando la sala volvió a tener compañía', async () => {
    listRooms.mockResolvedValue([room('activa', 3)]);
    await runMeetJanitor(NOW);
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      { slug: { $in: ['activa'] }, soloSince: { $exists: true } },
      { $unset: { soloSince: '' } }
    );
  });

  it('deja las salas VACÍAS a `empty_timeout` de LiveKit (no las cierra a mano)', async () => {
    listRooms.mockResolvedValue([room('vacia', 0)]);
    const r = await runMeetJanitor(NOW);
    expect(r.closed).toBe(0);
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it('nunca cierra una sala de LiveKit sin fila en Mongo (no puede saber desde cuándo está sola)', async () => {
    listRooms.mockResolvedValue([room('huerfana', 1)]);
    h.foundDocs = [];
    const r = await runMeetJanitor(NOW);
    expect(r.closed).toBe(0);
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it('es no-fatal si LiveKit está caído', async () => {
    listRooms.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(runMeetJanitor(NOW)).resolves.toEqual({ seen: 0, closed: 0 });
  });

  it('separa correctamente un lote mixto', async () => {
    listRooms.mockResolvedValue([
      room('vieja', 1),
      room('nueva', 1),
      room('llena', 4),
      room('vacia', 0),
    ]);
    h.foundDocs = [
      { slug: 'vieja', soloSince: new Date(NOW - SOLO_MAX_MS - 1) },
      { slug: 'nueva', soloSince: new Date(NOW - 1000) },
    ];
    const r = await runMeetJanitor(NOW);
    expect(r).toEqual({ seen: 4, closed: 1 });
    expect(deleteRoom).toHaveBeenCalledOnce();
    expect(deleteRoom).toHaveBeenCalledWith('vieja');
  });
});

describe('markMeetRoomAlive', () => {
  it('reinicia el reloj sólo de una sala activa que tenga la marca puesta', async () => {
    await markMeetRoomAlive('sala-uno');
    expect(updateOne).toHaveBeenCalledWith(
      { slug: 'sala-uno', status: 'active', soloSince: { $exists: true } },
      { $unset: { soloSince: '' } }
    );
  });
});
