import { describe, it, expect } from 'vitest';
import { normalizeAllDayRange } from '../calendar-dates';

/**
 * El fin de un evento "todo el día" debe quedar EXCLUSIVO (00:00 del día siguiente al último), sin
 * duplicar día cuando el fin ya viene exclusivo — el bug que B encontró: el +1 incondicional
 * convertía un evento de un día en dos y extendía la edición cada vez. Fechas locales (medianoche
 * local) para reflejar lo que arma el formulario.
 */
describe('normalizeAllDayRange (allDay fin exclusivo, sin doble día)', () => {
  const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

  it('fin INCLUSIVO mismo día (modal manual) → +1 día (evento de un día)', () => {
    const { start, end } = normalizeAllDayRange(at(2026, 6, 12, 9), at(2026, 6, 12, 10));
    expect(start).toEqual(at(2026, 6, 12));
    expect(end).toEqual(at(2026, 6, 13)); // exclusivo: 00:00 del día siguiente
  });

  it('fin YA EXCLUSIVO de selección de un día (00:00 día siguiente) → se mantiene (no duplica)', () => {
    const { start, end } = normalizeAllDayRange(at(2026, 6, 12), at(2026, 6, 13));
    expect(start).toEqual(at(2026, 6, 12));
    expect(end).toEqual(at(2026, 6, 13)); // NO 2026-06-14
  });

  it('multi-día ya exclusivo (D..D+2 → fin 00:00 D+3) → se mantiene', () => {
    const { start, end } = normalizeAllDayRange(at(2026, 6, 12), at(2026, 6, 15));
    expect(start).toEqual(at(2026, 6, 12));
    expect(end).toEqual(at(2026, 6, 15)); // 3 días, sin duplicar
  });

  it('round-trip estable: editar y re-normalizar un evento ya exclusivo no lo extiende', () => {
    const once = normalizeAllDayRange(at(2026, 6, 12), at(2026, 6, 13));
    const twice = normalizeAllDayRange(once.start, once.end);
    expect(twice.start).toEqual(once.start);
    expect(twice.end).toEqual(once.end); // idempotente
  });

  it('fin anterior al inicio → un día desde el inicio (no rango inválido)', () => {
    const { start, end } = normalizeAllDayRange(at(2026, 6, 12), at(2026, 6, 10));
    expect(start).toEqual(at(2026, 6, 12));
    expect(end).toEqual(at(2026, 6, 13));
  });

  it('no muta las fechas de entrada', () => {
    const s = at(2026, 6, 12, 9);
    const e = at(2026, 6, 12, 10);
    normalizeAllDayRange(s, e);
    expect(s).toEqual(at(2026, 6, 12, 9));
    expect(e).toEqual(at(2026, 6, 12, 10));
  });
});
