import { ImapFlow } from 'imapflow';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.js';

type SmtpOptions = SMTPTransport.Options | SMTPPool.Options;

/**
 * Seam de inyección para los transportes de correo (IMAP/SMTP).
 *
 * Producción usa las librerías reales (imapflow / nodemailer). Los tests E2E full-stack
 * arrancan la API como un PROCESO real, donde `vi.mock()` no aplica; instalan fakes en
 * proceso vía {@link setImapClientFactory} / {@link setSmtpTransportFactory} ANTES de
 * construir la app. Mantiene el código de negocio (`services/imap.ts`, `services/smtp.ts`,
 * `services/auth.ts`) agnóstico del transporte concreto, sin flags de "modo fake" ni
 * ramas de test embebidas en los hot-paths.
 */
export type ImapClientFactory = (options: ConstructorParameters<typeof ImapFlow>[0]) => ImapFlow;
export type SmtpTransportFactory = (options: SmtpOptions) => Transporter;

let imapFactory: ImapClientFactory = (options) => new ImapFlow(options);
let smtpFactory: SmtpTransportFactory = (options) => createTransport(options);

/** Construye un cliente IMAP (real por defecto; fake si se inyectó uno). */
export function createImapClient(options: ConstructorParameters<typeof ImapFlow>[0]): ImapFlow {
  return imapFactory(options);
}

/** Construye un transporte SMTP (real por defecto; fake si se inyectó uno). */
export function createSmtpTransport(options: SmtpOptions): Transporter {
  return smtpFactory(options);
}

// Defensa: los setters son SÓLO para tests E2E in-process. Si producción/dev pudieran
// invocarlos, un bug o un import malicioso podría desviar todo el correo a un transporte
// falso (no-entrega silenciosa / exfiltración). Sólo se permiten con NODE_ENV=test.
function assertTestOnly(name: string): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`${name} sólo puede usarse con NODE_ENV=test (es un seam de test)`);
  }
}

/** Sobrescribe la fábrica de clientes IMAP (uso exclusivo de tests E2E in-process). */
export function setImapClientFactory(factory: ImapClientFactory): void {
  assertTestOnly('setImapClientFactory');
  imapFactory = factory;
}

/** Sobrescribe la fábrica de transportes SMTP (uso exclusivo de tests E2E in-process). */
export function setSmtpTransportFactory(factory: SmtpTransportFactory): void {
  assertTestOnly('setSmtpTransportFactory');
  smtpFactory = factory;
}
