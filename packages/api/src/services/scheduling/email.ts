import { Booking } from '../../models/Booking.js';
import { Account } from '../../models/Account.js';
import { createSmtpTransport } from '../mail-transport.js';
import { getBranding } from '../branding.js';
import { buildIcs, type IcsMethod } from './ics.js';

/**
 * Handler del job `send-email` (BullMQ, Fase 3.4): envía la confirmación / cancelación / reprogramación
 * al invitado por el SMTP del HOST (entregabilidad y branding propios — misión Bifrost). Adjunta ICS.
 *
 * El correo sale del dominio del host (su cuenta primaria). El branding (nombre) viene del admin de
 * email existente (review del PM: la página/correos usan la marca configurada en Admin ▸ Marca).
 * Idempotencia del job: BullMQ usa `jobId` determinista (confirm:/cancel:/reschedule:<bookingId>).
 */

export type EmailKind = 'confirmation' | 'cancellation' | 'reschedule';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: tz,
  }).format(d);
}

export async function sendBookingEmail(bookingId: string, kind: EmailKind): Promise<void> {
  const booking = await Booking.findById(bookingId);
  if (!booking) return; // la reserva ya no existe (compensada/borrada): nada que enviar.
  // Cuenta primaria del host (de ahí sale el correo). Si no hay SMTP, el job falla → reintenta/DLQ.
  const account = await Account.findOne({ userId: booking.userId, isPrimary: true });
  if (!account) throw new Error(`booking ${bookingId}: host sin cuenta primaria para enviar`);

  const brand = await getBranding();
  const brandName = brand.companyName ?? 'Bifrost';
  const inviteeTz = booking.invitee.timezone;
  const title = booking.snapshot.title;
  const when = fmt(booking.startAt, inviteeTz);
  const location = booking.snapshot.location.value;

  const method: IcsMethod = kind === 'cancellation' ? 'CANCEL' : 'REQUEST';
  const sequence = kind === 'confirmation' ? 0 : 1;
  const ics = buildIcs({
    uid: booking.icsUid,
    method,
    sequence,
    start: booking.startAt,
    end: booking.endAt,
    summary: title,
    location,
    organizer: { name: account.name, email: account.email },
    attendee: { name: booking.invitee.name, email: booking.invitee.email },
    stamp: new Date(),
  });

  const heading =
    kind === 'cancellation'
      ? `Reunión cancelada: ${title}`
      : kind === 'reschedule'
        ? `Reunión reprogramada: ${title}`
        : `Reunión confirmada: ${title}`;
  const subject = `${heading} — ${when}`;
  const html =
    `<div style="font-family:sans-serif;max-width:480px">` +
    `<h2>${escapeHtml(heading)}</h2>` +
    `<p>🕑 ${escapeHtml(when)} (${escapeHtml(inviteeTz)})</p>` +
    (location ? `<p>📍 ${escapeHtml(location)}</p>` : '') +
    `<p>Con ${escapeHtml(account.name)}.</p>` +
    `<hr><p style="color:#888;font-size:12px">${escapeHtml(brandName)}</p></div>`;
  const text = `${heading}\n${when} (${inviteeTz})\n${location ? `Lugar: ${location}\n` : ''}Con ${account.name}.\n${brandName}`;

  const transporter = createSmtpTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.smtp.authUser, pass: account.getSmtpCredentials() },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  try {
    await transporter.sendMail({
      // `from` y `to` ESTRUCTURADOS (nodemailer arma la cabecera): inmune a header-injection (review B/D-016).
      from: { name: account.name, address: account.email },
      to: { name: booking.invitee.name, address: booking.invitee.email },
      subject,
      text,
      html,
      icalEvent: { method, content: ics, filename: 'invite.ics' },
    });
  } finally {
    transporter.close();
  }
}
