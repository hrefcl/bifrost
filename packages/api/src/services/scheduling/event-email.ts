import { CalendarEvent } from '../../models/CalendarEvent.js';
import { Account } from '../../models/Account.js';
import { createSmtpTransport } from '../mail-transport.js';
import { getBranding } from '../branding.js';
import { buildIcs } from './ics.js';

/**
 * Handler del job `send-event-invite`: envía la INVITACIÓN de un evento de calendario a UN invitado
 * (attendee), por el SMTP del HOST (entregabilidad + branding propios). Adjunta ICS (METHOD:REQUEST) y,
 * si el evento tiene sala de Bifrost Meet, incluye el link.
 *
 * Un job por (eventId, email) → idempotente por jobId (`event-invite-<eventId>-<emailNormalizado>`), así
 * un retry o una re-edición no duplica invitaciones para el mismo invitado.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(d: Date): string {
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(d);
}

export async function sendEventInvite(eventId: string, attendeeEmail: string): Promise<void> {
  const event = await CalendarEvent.findById(eventId);
  if (!event) return; // evento borrado: nada que enviar.
  // Soft-delete (con Google activo, DELETE deja cancelled + deleting): NO invitar a un evento borrado
  // aunque el doc todavía exista mientras el sync lo elimina (review B — HIGH).
  if (event.status === 'cancelled' || event.googleSyncStatus === 'deleting') return;
  const target = attendeeEmail.toLowerCase();
  const attendee = event.attendees?.find((a) => a.email.toLowerCase() === target);
  if (!attendee) return; // el invitado ya no está (fue removido en una edición): no invitar.

  // Cuenta primaria del host (de ahí sale el correo). Sin SMTP → el job falla y reintenta.
  const account = await Account.findOne({ userId: event.userId, isPrimary: true });
  if (!account) throw new Error(`event ${eventId}: host sin cuenta primaria para invitar`);

  const brand = await getBranding();
  const brandName = brand.companyName ?? 'Bifrost';
  const when = fmt(event.startDate);
  const summary = event.summary;
  const location = event.location;
  const meetUrl = event.meetUrl;

  const ics = buildIcs({
    uid: event.uid,
    method: 'REQUEST',
    sequence: 0,
    start: event.startDate,
    end: event.endDate,
    summary,
    location: meetUrl ? (location ?? meetUrl) : location,
    organizer: { name: account.name, email: account.email },
    attendee: { name: attendee.name, email: attendee.email },
    stamp: new Date(),
  });

  const heading = `Invitación: ${summary}`;
  const html =
    `<div style="font-family:sans-serif;max-width:480px">` +
    `<h2>${escapeHtml(heading)}</h2>` +
    `<p>🕑 ${escapeHtml(when)} (UTC)</p>` +
    (location ? `<p>📍 ${escapeHtml(location)}</p>` : '') +
    (meetUrl
      ? `<p>🎥 <a href="${escapeHtml(meetUrl)}">Unirse a la videollamada de Bifrost Meet</a></p>`
      : '') +
    (event.description ? `<p>${escapeHtml(event.description)}</p>` : '') +
    `<p>Te invita ${escapeHtml(account.name)}.</p>` +
    `<hr><p style="color:#888;font-size:12px">${escapeHtml(brandName)}</p></div>`;
  const text =
    `${heading}\n${when} (UTC)\n` +
    (location ? `Lugar: ${location}\n` : '') +
    (meetUrl ? `Videollamada: ${meetUrl}\n` : '') +
    (event.description ? `${event.description}\n` : '') +
    `Te invita ${account.name}.\n${brandName}`;

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
      // Estructurados (nodemailer arma la cabecera) → inmune a header-injection (mismo patrón que la reserva).
      from: { name: account.name, address: account.email },
      to: { name: attendee.name ?? attendee.email, address: attendee.email },
      subject: `${heading} — ${when}`,
      text,
      html,
      icalEvent: { method: 'REQUEST', content: ics, filename: 'invite.ics' },
    });
  } finally {
    transporter.close();
  }
}
