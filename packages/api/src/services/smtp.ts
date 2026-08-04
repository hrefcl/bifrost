import { type SendMailOptions } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { createSmtpTransport } from './mail-transport.js';
import type { IAccount } from '../models/Account.js';
import type { IDraft } from '../models/Draft.js';
import { User } from '../models/User.js';
import { plainTextFromHtml } from '../lib/sanitizeHtml.js';
import { providerForType } from './storage/index.js';

export interface SendResult {
  messageId: string;
  raw: Buffer;
}

/**
 * Error de ENTREGA con un statusCode HTTP mapeado, para que el error handler global NO lo colapse en un
 * genérico "Internal Server Error" (que ocultaba el motivo real — p.ej. "el mensaje excede el tamaño
 * máximo" del MTA). Un 4xx además NO se enmascara en prod, así el usuario ve la causa accionable.
 */
export class MailDeliveryError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'MailDeliveryError';
    this.statusCode = statusCode;
  }
}

/**
 * Traduce un error de nodemailer/SMTP a un MailDeliveryError con statusCode útil. El caso más común con
 * adjuntos es el RECHAZO POR TAMAÑO del MTA (Postfix `message_size_limit`, SMTP 552/523) → 413. El resto
 * de rechazos SMTP (auth/relay/destinatario) se exponen con su texto real (502); los timeouts/conexión,
 * como 504. Si no reconoce el error, devuelve el original (→ 500) para no ocultar bugs reales.
 */
export function mapSmtpError(err: unknown): unknown {
  const e = err as { responseCode?: number; code?: string; response?: string; message?: string };
  const responseText = e.response ?? e.message ?? '';
  const isSize =
    e.responseCode === 552 ||
    e.responseCode === 523 ||
    /message size|size exceeds|too large|too big/i.test(responseText);
  if (isSize) {
    return new MailDeliveryError(
      'El mensaje es demasiado grande para el servidor de correo (por los adjuntos). Reducí el tamaño de los archivos.',
      413
    );
  }
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || e.code === 'ESOCKET') {
    return new MailDeliveryError(
      'No se pudo conectar con el servidor de correo (timeout). Reintentá en un momento.',
      504
    );
  }
  if (typeof e.responseCode === 'number' && responseText.trim().length > 0) {
    return new MailDeliveryError(
      `El servidor de correo rechazó el envío: ${responseText.trim()}`,
      502
    );
  }
  return err; // desconocido → que salga como 500 (no ocultar un bug real como si fuera del MTA)
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

    // Nombre visible del From = displayName del usuario (el que edita en su Perfil). Antes se usaba
    // `account.name`, que al crear la cuenta quedó = el email → el correo salía como "admin@x <admin@x>".
    // Fallback a account.name si el usuario no tiene nombre (no debería: displayName es required).
    const user = await User.findById(account.userId).select('displayName').lean();
    const dn = user?.displayName.trim();
    const fromName = dn && dn.length > 0 ? dn : account.name;

    // OJO: el `bcc` NO va en las opciones del RAW — sólo en el envelope SMTP (entrega).
    // Si fuera al raw, MailComposer podría dejar una cabecera Bcc: y la copia a Sent
    // (APPEND del mismo raw) filtraría los destinatarios ocultos.
    const options: SendMailOptions = {
      from: `${fromName} <${account.email}>`,
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

    // Adjuntos: cada uno se lee de SU provider de origen (provider-bound), nunca del activo.
    // El contenido se carga acá (no en el draft) para no inflar Mongo ni el JSON de la API.
    if (draft.attachments.length > 0) {
      options.attachments = await Promise.all(
        draft.attachments.map(async (att) => ({
          filename: att.filename,
          content: await (await providerForType(att.providerType)).get(att.storageKey),
          contentType: att.contentType,
        }))
      );
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
