/**
 * Generación de ICS (RFC 5545) para las reservas de la agenda. Se adjunta al correo de confirmación
 * para que el invitado lo agregue a cualquier calendario (review C-M12 / B-LOW).
 *
 * Decisiones (review B/C):
 *  - `DTSTART`/`DTEND` en UTC (sufijo `Z`) → se evita construir `VTIMEZONE` a mano (muy propenso a error).
 *  - Escape de TEXT (`\` `;` `,` y saltos de línea) y FOLDING a 75 octetos por línea, CRLF.
 *  - `METHOD:REQUEST` al confirmar, `CANCEL` al cancelar; `UID` estable (mismo en confirm/cancel).
 */

export type IcsMethod = 'REQUEST' | 'CANCEL';

export interface IcsInput {
  uid: string;
  method: IcsMethod;
  /** Secuencia: 0 al crear, +1 en cada cambio/cancelación (los clientes lo usan para actualizar). */
  sequence: number;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  organizer: { name?: string; email: string };
  attendee: { name?: string; email: string };
  /** Marca de creación/edición; instante UTC. */
  stamp: Date;
}

/** Escapa un valor TEXT de iCalendar (RFC 5545 §3.3.11). */
function escapeText(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** UTC → "YYYYMMDDTHHMMSSZ". */
function toIcsUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Folding RFC 5545: líneas ≤75 OCTETOS; continuación con CRLF + espacio. Cuenta bytes UTF-8. */
function foldLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    // 75 en la primera, 74 en continuaciones (el espacio inicial cuenta).
    const limit = out.length === 0 ? 75 : 74;
    if (curBytes + chBytes > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += chBytes;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function person(
  label: 'ORGANIZER' | 'ATTENDEE',
  p: { name?: string; email: string },
  extraParams = ''
): string {
  // Los PARÁMETROS (CN, RSVP, PARTSTAT) van ANTES del ':' (review B-MED: si no, quedan como parte del
  // valor mailto y el cliente los ignora). El valor es `mailto:email`.
  const cn = p.name ? `;CN=${escapeText(p.name)}` : '';
  return `${label}${cn}${extraParams}:mailto:${p.email}`;
}

/** Construye el cuerpo VCALENDAR. Cada línea va foldeada y unida con CRLF. */
export function buildIcs(input: IcsInput): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Bifrost//Agenda//ES',
    'CALSCALE:GREGORIAN',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `SEQUENCE:${String(input.sequence)}`,
    `DTSTAMP:${toIcsUtc(input.stamp)}`,
    `DTSTART:${toIcsUtc(input.start)}`,
    `DTEND:${toIcsUtc(input.end)}`,
    `SUMMARY:${escapeText(input.summary)}`,
    person('ORGANIZER', input.organizer),
    person('ATTENDEE', input.attendee, ';RSVP=TRUE;PARTSTAT=NEEDS-ACTION'),
    `STATUS:${input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
  ];
  if (input.description) lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  if (input.location) lines.push(`LOCATION:${escapeText(input.location)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
