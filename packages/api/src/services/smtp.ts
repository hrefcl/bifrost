import { type SendMailOptions } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { createSmtpTransport } from './mail-transport.js';
import type { IAccount } from '../models/Account.js';
import type { IDraft } from '../models/Draft.js';
import { plainTextFromHtml } from '../lib/sanitizeHtml.js';

export interface SendResult {
  messageId: string;
  raw: Buffer;
}

function buildRaw(options: SendMailOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(options).compile().build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

/**
 * Envía el draft con un Message-ID DETERMINISTA (provisto por el caller, que ya lo
 * persistió). Construye el RAW una sola vez: el mismo buffer se envía por SMTP y se
 * devuelve para hacer APPEND idéntico en la carpeta Sent. Transporter con pool +
 * timeouts y cierre explícito (evita leak de sockets).
 */
export async function sendDraft(
  account: IAccount,
  draft: IDraft,
  messageId: string
): Promise<SendResult> {
  const password = account.getSmtpCredentials();
  const transporter = createSmtpTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.smtp.authUser, pass: password },
    pool: true,
    maxConnections: 3,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });

  try {
    const html = draft.bodyHtml ?? '';
    const text = draft.bodyText ?? plainTextFromHtml(html);
    const to = draft.to.map((a) => a.address);
    const cc = draft.cc?.map((a) => a.address) ?? [];
    const bcc = draft.bcc?.map((a) => a.address) ?? [];

    // OJO: el `bcc` NO va en las opciones del RAW — sólo en el envelope SMTP (entrega).
    // Si fuera al raw, MailComposer podría dejar una cabecera Bcc: y la copia a Sent
    // (APPEND del mismo raw) filtraría los destinatarios ocultos.
    const options: SendMailOptions = {
      from: `${account.name} <${account.email}>`,
      to,
      cc: cc.length > 0 ? cc : undefined,
      subject: draft.subject,
      text,
      html: html || undefined,
      messageId,
      date: new Date(),
    };
    if (draft.replyTo?.messageId) {
      options.inReplyTo = draft.replyTo.messageId;
      options.references = draft.replyTo.references;
    }

    const raw = await buildRaw(options);
    await transporter.sendMail({
      envelope: { from: account.email, to: [...to, ...cc, ...bcc] },
      raw,
    });
    return { messageId, raw };
  } finally {
    transporter.close();
  }
}
