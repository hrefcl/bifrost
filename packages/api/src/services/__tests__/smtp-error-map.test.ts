import { describe, it, expect } from 'vitest';
import { mapSmtpError, MailDeliveryError } from '../smtp.js';

/**
 * El error del MTA/SMTP debe llegar al usuario como algo ACCIONABLE, no como "Internal Server Error".
 * El caso clave es el rechazo por TAMAÑO del adjunto (Postfix message_size_limit → SMTP 552).
 */
describe('mapSmtpError', () => {
  it('rechazo por tamaño (SMTP 552) → 413 con mensaje de "demasiado grande"', () => {
    const mapped = mapSmtpError({
      responseCode: 552,
      response: '552 5.3.4 Message size exceeds fixed maximum message size',
    });
    expect(mapped).toBeInstanceOf(MailDeliveryError);
    expect((mapped as MailDeliveryError).statusCode).toBe(413);
    expect((mapped as MailDeliveryError).message).toMatch(/grande/i);
  });

  it('detecta el tamaño por el TEXTO aunque el código no sea 552', () => {
    const mapped = mapSmtpError({ responseCode: 500, response: 'message size too large' });
    expect((mapped as MailDeliveryError).statusCode).toBe(413);
  });

  it('523 (SES message too large) → 413', () => {
    const mapped = mapSmtpError({ responseCode: 523, response: '523 message too big' });
    expect((mapped as MailDeliveryError).statusCode).toBe(413);
  });

  it('timeout/conexión → 504', () => {
    expect((mapSmtpError({ code: 'ETIMEDOUT' }) as MailDeliveryError).statusCode).toBe(504);
    expect(
      (mapSmtpError({ code: 'ESOCKET', message: 'socket' }) as MailDeliveryError).statusCode
    ).toBe(504);
  });

  it('otro rechazo SMTP con texto → 502 exponiendo la respuesta real', () => {
    const mapped = mapSmtpError({ responseCode: 550, response: '550 relay not permitted' });
    expect((mapped as MailDeliveryError).statusCode).toBe(502);
    expect((mapped as MailDeliveryError).message).toMatch(/relay not permitted/);
  });

  it('error DESCONOCIDO se devuelve tal cual (→ 500, no oculta bugs reales como si fueran del MTA)', () => {
    const original = new Error('boom inesperado');
    expect(mapSmtpError(original)).toBe(original);
  });
});
