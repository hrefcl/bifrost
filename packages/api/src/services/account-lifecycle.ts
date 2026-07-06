import { Account } from '../models/Account.js';
import { Email } from '../models/Email.js';
import { Folder } from '../models/Folder.js';
import { Draft } from '../models/Draft.js';
import { Contact } from '../models/Contact.js';
import { CalendarEvent } from '../models/CalendarEvent.js';
import { User } from '../models/User.js';
import { provisioningEnabled, getActiveMailboxProvider } from './mailbox/index.js';

/** Falló la revocación del buzón REAL en el mailserver. El caller debe abortar (no borrar el registro). */
export class MailboxRevokeError extends Error {
  constructor(cause?: unknown) {
    super('No se pudo eliminar el buzón en el servidor de correo.');
    this.name = 'MailboxRevokeError';
    this.cause = cause;
  }
}

/**
 * Borra una cuenta y todos sus datos acotados, de forma CONSISTENTE entre el panel /admin y la API
 * máquina (una sola verdad → sin drift). Pasos:
 *  1. Si Bifrost es autoridad de cuentas, REVOCA el buzón real PRIMERO (quita el acceso IMAP/SMTP). Si
 *     el mailserver falla, lanza `MailboxRevokeError` ANTES de tocar la DB → no deja estado a medias.
 *     NO se purga el Maildir (sin línea en accounts.cf ya no hay login; el correo queda recuperable).
 *  2. Borra el Account y sus datos accountId-bound (Email/Folder/Draft/CalendarEvent).
 *  3. Si era la ÚLTIMA cuenta del usuario, borra el User y sus datos userId-bound (Contact). Los
 *     AttachmentBlob (userId-bound) los recicla el GC mark-and-sweep al quedar sin drafts.
 *
 * NO valida authz (anti-lockout, etc.): eso es responsabilidad del caller (el panel lo hace antes).
 */
export async function deleteAccountCascade(account: {
  _id: unknown;
  userId: unknown;
  email: string;
}): Promise<void> {
  if (await provisioningEnabled()) {
    try {
      const provider = await getActiveMailboxProvider();
      await provider.deleteMailbox(account.email);
      // Quitar sus aliases del postfix-virtual.cf → no dejar aliases HUÉRFANOS apuntando a un buzón que
      // ya no existe (rebotarían). Idempotente (setAliases con []); mismo try → un fallo aborta antes de la DB.
      await provider.setAliases(account.email, []);
    } catch (err) {
      throw new MailboxRevokeError(err);
    }
  }
  await Account.deleteOne({ _id: account._id });
  await Promise.all([
    Email.deleteMany({ accountId: account._id }),
    Folder.deleteMany({ accountId: account._id }),
    Draft.deleteMany({ accountId: account._id }),
    CalendarEvent.deleteMany({ accountId: account._id }),
  ]);
  const remaining = await Account.countDocuments({ userId: account.userId });
  if (remaining === 0) {
    await Promise.all([
      User.deleteOne({ _id: account.userId }),
      Contact.deleteMany({ userId: account.userId }),
    ]);
  }
}
