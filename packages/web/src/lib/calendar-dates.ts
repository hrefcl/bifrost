/**
 * Normaliza el rango de un evento "todo el día" a la convención de FullCalendar/iCal: inicio a
 * 00:00 del día, fin EXCLUSIVO (00:00 del día siguiente al último). El `end` de entrada YA puede
 * venir exclusivo (selección de FullCalendar `arg.end`, o el `endDate` de un evento guardado), así
 * que sólo se avanza un día cuando el fin NO es ya posterior al inicio (fin inclusivo del mismo día,
 * p.ej. al marcar "todo el día" en el modal manual). Esto hace el round-trip editar→guardar estable
 * y evita duplicar un día (review B). Devuelve fechas nuevas; no muta las de entrada.
 */
export function normalizeAllDayRange(start: Date, end: Date): { start: Date; end: Date } {
  const s = new Date(start);
  const e = new Date(end);
  s.setHours(0, 0, 0, 0);
  e.setHours(0, 0, 0, 0);
  if (e.getTime() <= s.getTime()) {
    e.setTime(s.getTime());
    e.setDate(e.getDate() + 1);
  }
  return { start: s, end: e };
}
