import { describe, it, expect } from 'vitest';
import {
  generateSlots,
  isSlotBookable,
  availabilityIntervalsForDate,
  type ResolvedSchedule,
  type SlotParams,
} from '../slots.js';

// Horario base: Lun–Vie 09:00–17:00 en America/Bogota (UTC-5 FIJO, sin DST → 09:00 local = 14:00 UTC
// todo el año; evita la trampa de hemisferio). weekday 1..5 (0=Dom..6=Sab).
const schedule = (over: Partial<ResolvedSchedule> = {}): ResolvedSchedule => ({
  timezone: 'America/Bogota',
  weeklyRules: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    intervals: [{ start: '09:00', end: '17:00' }],
  })),
  overrides: [],
  ...over,
});

const params = (over: Partial<SlotParams> = {}): SlotParams => ({
  durationMinutes: 30,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minimumNoticeMin: 0,
  dateRangeDays: 365,
  ...over,
});

const now0 = new Date('2026-07-01T00:00:00.000Z'); // antes de la ventana de prueba (jul 2026)
const iso = (d: Date): string => d.toISOString();

describe('availabilityIntervalsForDate', () => {
  it('regla semanal por weekday; override REEMPLAZA el día (vacío=vacación, no-vacío=especial)', () => {
    const s = schedule({
      overrides: [
        { date: '2026-07-06', intervals: [] }, // lunes: vacación
        { date: '2026-07-11', intervals: [{ start: '10:00', end: '14:00' }] }, // sábado especial
      ],
    });
    expect(availabilityIntervalsForDate('2026-07-07', s)).toEqual([
      { startMin: 540, endMin: 1020 },
    ]); // martes
    expect(availabilityIntervalsForDate('2026-07-06', s)).toEqual([]); // lunes vacación
    expect(availabilityIntervalsForDate('2026-07-11', s)).toEqual([{ startMin: 600, endMin: 840 }]); // sábado
  });
});

describe('generateSlots — básico', () => {
  it('martes 09–17, slots 30min → 16; primero 09:00 (14:00Z), último 16:30 (21:30Z)', () => {
    const from = new Date('2026-07-07T00:00:00.000Z');
    const to = new Date('2026-07-08T00:00:00.000Z');
    const slots = generateSlots({
      from,
      to,
      now: now0,
      schedule: schedule(),
      params: params(),
      busy: [],
    });
    expect(slots).toHaveLength(16);
    expect(iso(slots[0])).toBe('2026-07-07T14:00:00.000Z');
    expect(iso(slots[slots.length - 1])).toBe('2026-07-07T21:30:00.000Z');
  });

  it('fin de semana sin regla → 0 slots', () => {
    const from = new Date('2026-07-11T00:00:00.000Z'); // sábado
    const to = new Date('2026-07-12T00:00:00.000Z');
    expect(
      generateSlots({ from, to, now: now0, schedule: schedule(), params: params(), busy: [] })
    ).toHaveLength(0);
  });
});

describe('generateSlots — descansos (varios intervalos)', () => {
  it('09–12 + 13–18 → ningún slot cruza la pausa 12–13', () => {
    const s = schedule({
      weeklyRules: [
        {
          weekday: 2,
          intervals: [
            { start: '09:00', end: '12:00' },
            { start: '13:00', end: '18:00' },
          ],
        },
      ],
    });
    const from = new Date('2026-07-07T00:00:00.000Z');
    const to = new Date('2026-07-08T00:00:00.000Z');
    const slots = generateSlots({ from, to, now: now0, schedule: s, params: params(), busy: [] });
    expect(slots).toHaveLength(16); // 6 (09–12) + 10 (13–18)
    expect(slots.map(iso)).not.toContain('2026-07-07T17:00:00.000Z'); // 12:00 local no inicia slot
  });

  it('intervalos SOLAPADOS (09–12 y 11–14) no producen slots duplicados', () => {
    const s = schedule({
      weeklyRules: [
        {
          weekday: 2,
          intervals: [
            { start: '09:00', end: '12:00' },
            { start: '11:00', end: '14:00' },
          ],
        },
      ],
    });
    const from = new Date('2026-07-07T00:00:00.000Z');
    const to = new Date('2026-07-08T00:00:00.000Z');
    const slots = generateSlots({ from, to, now: now0, schedule: s, params: params(), busy: [] });
    // unión real 09–14 = 10 slots de 30min; sin duplicados en el solape 11–12.
    expect(slots).toHaveLength(10);
    expect(new Set(slots.map(iso)).size).toBe(slots.length);
  });
});

describe('generateSlots — buffers y overlap', () => {
  it('un ocupado 10:00–10:30 local (15:00–15:30Z) elimina ese slot', () => {
    const from = new Date('2026-07-07T00:00:00.000Z');
    const to = new Date('2026-07-08T00:00:00.000Z');
    const busy = [
      { start: new Date('2026-07-07T15:00:00.000Z'), end: new Date('2026-07-07T15:30:00.000Z') },
    ];
    const slots = generateSlots({
      from,
      to,
      now: now0,
      schedule: schedule(),
      params: params(),
      busy,
    });
    expect(slots.map(iso)).not.toContain('2026-07-07T15:00:00.000Z');
    expect(slots).toHaveLength(15);
  });

  it('buffer 15min antes/después bloquea los slots adyacentes', () => {
    const from = new Date('2026-07-07T00:00:00.000Z');
    const to = new Date('2026-07-08T00:00:00.000Z');
    const busy = [
      { start: new Date('2026-07-07T15:00:00.000Z'), end: new Date('2026-07-07T15:30:00.000Z') },
    ]; // 10:00–10:30
    const slots = generateSlots({
      from,
      to,
      now: now0,
      schedule: schedule(),
      params: params({ bufferBeforeMin: 15, bufferAfterMin: 15 }),
      busy,
    });
    expect(slots.map(iso)).not.toContain('2026-07-07T14:30:00.000Z'); // 09:30 bloqueado
    expect(slots.map(iso)).not.toContain('2026-07-07T15:30:00.000Z'); // 10:30 bloqueado
    expect(slots.map(iso)).toContain('2026-07-07T14:00:00.000Z'); // 09:00 libre
  });

  it('buffer ASIMÉTRICO del ocupado: una reserva con bufferAfter=15 bloquea el slot pegado aunque el candidato no tenga bufferBefore (review B-HIGH)', () => {
    const from = new Date('2026-07-07T00:00:00.000Z');
    const to = new Date('2026-07-08T00:00:00.000Z');
    // ocupado 10:00–10:30 local (15:00–15:30Z) con bufferAfter 15 → bloquea hasta 10:45.
    const busy = [
      {
        start: new Date('2026-07-07T15:00:00.000Z'),
        end: new Date('2026-07-07T15:30:00.000Z'),
        bufferAfterMin: 15,
      },
    ];
    const slots = generateSlots({
      from,
      to,
      now: now0,
      schedule: schedule(),
      params: params(),
      busy,
    });
    // candidato 10:30 (15:30Z), sin bufferBefore propio, DEBE quedar bloqueado por el bufferAfter del ocupado
    expect(slots.map(iso)).not.toContain('2026-07-07T15:30:00.000Z');
    // 10:00 también (es el propio ocupado), pero 11:00 (16:00Z) ya está libre (>=10:45)
    expect(slots.map(iso)).toContain('2026-07-07T16:00:00.000Z');
  });
});

describe('generateSlots — minNotice, dateRange, dailyLimit', () => {
  it('minNotice 24h recorta los slots demasiado próximos a now', () => {
    const now = new Date('2026-07-07T14:30:00.000Z'); // 09:30 local del martes
    const from = new Date('2026-07-07T00:00:00.000Z');
    const to = new Date('2026-07-08T00:00:00.000Z');
    expect(
      generateSlots({
        from,
        to,
        now,
        schedule: schedule(),
        params: params({ minimumNoticeMin: 1440 }),
        busy: [],
      })
    ).toHaveLength(0);
  });

  it('dateRange 1 día excluye slots más allá de la ventana', () => {
    const now = new Date('2026-07-07T00:00:00.000Z');
    const from = new Date('2026-07-07T00:00:00.000Z');
    const to = new Date('2026-07-31T00:00:00.000Z');
    const slots = generateSlots({
      from,
      to,
      now,
      schedule: schedule(),
      params: params({ dateRangeDays: 1 }),
      busy: [],
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((d) => d.getTime() <= now.getTime() + 24 * 60 * 60_000)).toBe(true);
  });

  it('dailyLimit alcanzado → 0 slots ese día', () => {
    const from = new Date('2026-07-07T00:00:00.000Z');
    const to = new Date('2026-07-08T00:00:00.000Z');
    const counts = new Map<string, number>([['2026-07-07', 5]]);
    expect(
      generateSlots({
        from,
        to,
        now: now0,
        schedule: schedule(),
        params: params({ dailyLimit: 5 }),
        busy: [],
        confirmedCountByDay: counts,
      })
    ).toHaveLength(0);
  });
});

describe('generateSlots — DST (Europe/Berlin spring-forward 2026-03-29)', () => {
  it('el slot 02:30 (gap) no se genera; quedan 4 slots de pared válidos', () => {
    const s: ResolvedSchedule = {
      timezone: 'Europe/Berlin',
      weeklyRules: [{ weekday: 0, intervals: [{ start: '01:00', end: '04:00' }] }], // domingo
      overrides: [],
    };
    const from = new Date('2026-03-29T00:00:00.000Z');
    const to = new Date('2026-03-29T05:00:00.000Z');
    const nowMar = new Date('2026-03-01T00:00:00.000Z');
    const slots = generateSlots({ from, to, now: nowMar, schedule: s, params: params(), busy: [] });
    // Pared válidas: 01:00,01:30,03:00,03:30 (02:00/02:30 inexistentes). UTC: 00:00,00:30,01:00,01:30.
    expect(slots.map(iso)).toEqual([
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T00:30:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-29T01:30:00.000Z',
    ]);
  });

  it('duración que CRUZA la transición se rechaza por contención real (review B-HIGH): 01:00–03:00, 60min', () => {
    const s: ResolvedSchedule = {
      timezone: 'Europe/Berlin',
      weeklyRules: [{ weekday: 0, intervals: [{ start: '01:00', end: '03:00' }] }],
      overrides: [],
    };
    const from = new Date('2026-03-29T00:00:00.000Z');
    const to = new Date('2026-03-29T05:00:00.000Z');
    const nowMar = new Date('2026-03-01T00:00:00.000Z');
    const slots = generateSlots({
      from,
      to,
      now: nowMar,
      schedule: s,
      params: params({ durationMinutes: 60, slotIncrementMin: 30 }),
      busy: [],
    });
    // Sólo 01:00 (CET) cabe: termina 03:00 local (=01:00Z, justo el fin del intervalo). 01:30 terminaría
    // 03:30 local (real >fin) → rechazado. 02:00/02:30 no existen.
    expect(slots.map(iso)).toEqual(['2026-03-29T00:00:00.000Z']);
  });

  it('fall-back 2026-10-25 (hora ambigua): ofrece la PRIMERA ocurrencia y el re-check la acepta; la 2ª se rechaza (consistencia display/lock, review B-MED)', () => {
    const s: ResolvedSchedule = {
      timezone: 'Europe/Berlin',
      weeklyRules: [{ weekday: 0, intervals: [{ start: '02:00', end: '04:00' }] }], // domingo fall-back
      overrides: [],
    };
    const from = new Date('2026-10-25T00:00:00.000Z');
    const to = new Date('2026-10-25T05:00:00.000Z');
    const nowOct = new Date('2026-10-01T00:00:00.000Z');
    const p = params();
    const slots = generateSlots({ from, to, now: nowOct, schedule: s, params: p, busy: [] });
    // 02:00 ambiguo → primera ocurrencia CEST(+2)=00:00Z; 02:30→00:30Z; 03:00 CET(+1)=02:00Z; 03:30→02:30Z.
    expect(slots.map(iso)).toContain('2026-10-25T00:00:00.000Z'); // 02:00 primera ocurrencia
    // el re-check bajo lock acepta esa primera ocurrencia
    expect(
      isSlotBookable({
        start: new Date('2026-10-25T00:00:00.000Z'),
        now: nowOct,
        schedule: s,
        params: p,
        busy: [],
        confirmedCountForDay: 0,
      })
    ).toBe(true);
    // …y rechaza la SEGUNDA ocurrencia del mismo 02:00 local (01:00Z) — nunca se ofreció
    expect(slots.map(iso)).not.toContain('2026-10-25T01:00:00.000Z');
    expect(
      isSlotBookable({
        start: new Date('2026-10-25T01:00:00.000Z'),
        now: nowOct,
        schedule: s,
        params: p,
        busy: [],
        confirmedCountForDay: 0,
      })
    ).toBe(false);
  });
});

describe('isSlotBookable — predicado bajo lock (re-check)', () => {
  const base = {
    now: now0,
    schedule: schedule(),
    params: params(),
    busy: [] as { start: Date; end: Date }[],
    confirmedCountForDay: 0,
  };
  it('acepta un slot válido alineado a la grilla (09:00 = 14:00Z)', () => {
    expect(isSlotBookable({ ...base, start: new Date('2026-07-07T14:00:00.000Z') })).toBe(true);
  });
  it('rechaza un tiempo off-grid dentro del intervalo (09:10 = 14:10Z)', () => {
    expect(isSlotBookable({ ...base, start: new Date('2026-07-07T14:10:00.000Z') })).toBe(false);
  });
  it('rechaza tiempos fuera del intervalo (08:30 y 17:00)', () => {
    expect(isSlotBookable({ ...base, start: new Date('2026-07-07T13:30:00.000Z') })).toBe(false); // 08:30
    expect(isSlotBookable({ ...base, start: new Date('2026-07-07T22:00:00.000Z') })).toBe(false); // 17:00 no cabe
  });
  it('rechaza si solapa un ocupado', () => {
    expect(
      isSlotBookable({
        ...base,
        start: new Date('2026-07-07T14:00:00.000Z'),
        busy: [
          {
            start: new Date('2026-07-07T14:00:00.000Z'),
            end: new Date('2026-07-07T14:30:00.000Z'),
          },
        ],
      })
    ).toBe(false);
  });
  it('rechaza si se alcanzó el límite diario', () => {
    expect(
      isSlotBookable({
        ...base,
        start: new Date('2026-07-07T14:00:00.000Z'),
        params: params({ dailyLimit: 3 }),
        confirmedCountForDay: 3,
      })
    ).toBe(false);
  });
});
