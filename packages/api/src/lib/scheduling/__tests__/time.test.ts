import { describe, it, expect } from 'vitest';
import { resolveWallTime, isValidZone, hostCalendarDay } from '../time.js';

const iso = (d: Date): string => d.toISOString();

describe('isValidZone', () => {
  it('acepta zonas IANA y rechaza basura', () => {
    expect(isValidZone('America/Santiago')).toBe(true);
    expect(isValidZone('Europe/Berlin')).toBe(true);
    expect(isValidZone('Not/AZone')).toBe(false);
    expect(isValidZone('')).toBe(false);
    expect(isValidZone('GMT+5')).toBe(false); // no es IANA
  });
});

describe('resolveWallTime — horas normales (sin transición)', () => {
  it('America/New_York verano (EDT -4): 09:00 → 13:00 UTC', () => {
    const r = resolveWallTime('2026-06-15', '09:00', 'America/New_York');
    expect('utc' in r && iso(r.utc)).toBe('2026-06-15T13:00:00.000Z');
  });
  it('America/Santiago verano (CLST -3): 10:00 → 13:00 UTC', () => {
    const r = resolveWallTime('2026-01-15', '10:00', 'America/Santiago');
    expect('utc' in r && iso(r.utc)).toBe('2026-01-15T13:00:00.000Z');
  });
  it('Europe/Berlin verano (CEST +2): 09:00 → 07:00 UTC', () => {
    const r = resolveWallTime('2026-06-15', '09:00', 'Europe/Berlin');
    expect('utc' in r && iso(r.utc)).toBe('2026-06-15T07:00:00.000Z');
  });
});

describe('resolveWallTime — GAP (spring-forward, hora inexistente) → skip', () => {
  it('America/New_York 2026-03-08 02:30 no existe', () => {
    expect(resolveWallTime('2026-03-08', '02:30', 'America/New_York')).toEqual({
      skip: 'nonexistent',
    });
  });
  it('Europe/Berlin 2026-03-29 02:30 no existe', () => {
    expect(resolveWallTime('2026-03-29', '02:30', 'Europe/Berlin')).toEqual({
      skip: 'nonexistent',
    });
  });
});

describe('resolveWallTime — AMBIGÜEDAD (fall-back, hora doble) → primera ocurrencia (menor UTC)', () => {
  it('America/New_York 2026-11-01 01:30 → 05:30 UTC (EDT, no 06:30 EST)', () => {
    const r = resolveWallTime('2026-11-01', '01:30', 'America/New_York');
    expect('utc' in r && iso(r.utc)).toBe('2026-11-01T05:30:00.000Z');
  });
  it('Europe/Berlin 2026-10-25 02:30 → 00:30 UTC (CEST, no 01:30 CET)', () => {
    const r = resolveWallTime('2026-10-25', '02:30', 'Europe/Berlin');
    expect('utc' in r && iso(r.utc)).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('resolveWallTime — validación de argumentos', () => {
  it('lanza con zona inválida', () => {
    expect(() => resolveWallTime('2026-01-01', '10:00', 'X/Y')).toThrow(/invalid IANA zone/);
  });
  it('lanza con fecha/hora no parseable', () => {
    expect(() => resolveWallTime('2026-13-40', 'aa:bb', 'UTC')).toThrow();
  });
  it('lanza (no devuelve skip silencioso) con hora fuera de rango como 24:00 o 25:00', () => {
    expect(() => resolveWallTime('2026-01-01', '24:00', 'UTC')).toThrow(/out-of-range/);
    expect(() => resolveWallTime('2026-01-01', '25:00', 'UTC')).toThrow(/out-of-range/);
    expect(() => resolveWallTime('2026-13-01', '10:00', 'UTC')).toThrow(/out-of-range/);
  });
  it('rechaza formato no estricto en vez de truncar (10:00:30, sufijos extra)', () => {
    expect(() => resolveWallTime('2026-01-01', '10:00:30', 'UTC')).toThrow(/HH:MM/);
    expect(() => resolveWallTime('2026-01-01-x', '10:00', 'UTC')).toThrow(/YYYY-MM-DD/);
  });
  it('distingue fecha de calendario INVÁLIDA (Feb 31) de un gap DST → lanza, no skip', () => {
    expect(() => resolveWallTime('2026-02-31', '10:00', 'UTC')).toThrow(/invalid calendar date/);
    expect(() => resolveWallTime('2026-04-31', '10:00', 'UTC')).toThrow(/invalid calendar date/);
    expect(() => resolveWallTime('2026-02-29', '10:00', 'UTC')).toThrow(/invalid calendar date/); // 2026 no bisiesto
  });
});

describe('resolveWallTime — casos adicionales (zona sin DST, bisiesto, medianoche)', () => {
  it('zona SIN DST (America/Bogota, -5 todo el año): 08:00 → 13:00 UTC en invierno y verano', () => {
    expect('utc' in resolveWallTime('2026-01-15', '08:00', 'America/Bogota') && true).toBe(true);
    const enero = resolveWallTime('2026-01-15', '08:00', 'America/Bogota');
    const julio = resolveWallTime('2026-07-15', '08:00', 'America/Bogota');
    expect('utc' in enero && iso(enero.utc)).toBe('2026-01-15T13:00:00.000Z');
    expect('utc' in julio && iso(julio.utc)).toBe('2026-07-15T13:00:00.000Z');
  });
  it('año bisiesto: 2024-02-29 es válido y resuelve', () => {
    const r = resolveWallTime('2024-02-29', '12:00', 'UTC');
    expect('utc' in r && iso(r.utc)).toBe('2024-02-29T12:00:00.000Z');
  });
  it('medianoche 00:00 en una zona estándar resuelve correctamente', () => {
    const r = resolveWallTime('2026-06-15', '00:00', 'America/New_York');
    expect('utc' in r && iso(r.utc)).toBe('2026-06-15T04:00:00.000Z'); // EDT -4
  });
});

describe('hostCalendarDay', () => {
  it('agrupa por día-calendario en la zona del host', () => {
    // 2026-01-16 01:30 UTC = 2026-01-15 22:30 en Santiago (-3) → día 15.
    const instant = new Date('2026-01-16T01:30:00.000Z');
    expect(hostCalendarDay(instant, 'America/Santiago')).toBe('2026-01-15');
    expect(hostCalendarDay(instant, 'UTC')).toBe('2026-01-16');
  });
});
