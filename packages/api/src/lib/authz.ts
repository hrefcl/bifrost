import { Account, type IAccount } from '../models/Account.js';
import { Email, type IEmail } from '../models/Email.js';
import { Folder, type IFolder } from '../models/Folder.js';
import { User } from '../models/User.js';

/** Error de autorización admin → 403 (a diferencia de OwnershipError que es 404). */
export class ForbiddenError extends Error {
  statusCode = 403;
  constructor(message = 'Admin role required') {
    super(message);
    this.name = 'Forbidden';
  }
}

/**
 * Exige rol admin CONSULTANDO LA DB (no se confía en el claim del JWT: el rol pudo cambiar
 * o el token ser viejo). Para preHandlers de rutas /admin. Lanza ForbiddenError (403) si no.
 */
export async function requireAdmin(userId: string): Promise<void> {
  const user = await User.findById(userId).select('role').lean();
  if (user?.role !== 'admin') throw new ForbiddenError();
}

/**
 * Error de autorización por propiedad. Se mapea a 404 (no 403) a propósito:
 * no se distingue "no existe" de "no es tuyo", para no filtrar la existencia
 * de recursos de otros tenants.
 */
export class OwnershipError extends Error {
  statusCode = 404;
  constructor(message = 'Not Found') {
    super(message);
    // 'Not Found' (con espacio) para alinear con los 404 manuales y el
    // setNotFoundHandler de app.ts → campo `error` consistente para el frontend.
    this.name = 'Not Found';
  }
}

/** La cuenta debe existir y pertenecer al usuario. */
export async function requireOwnedAccount(userId: string, accountId: string): Promise<IAccount> {
  const account = await Account.findOne({ _id: accountId, userId });
  if (!account) throw new OwnershipError('Account not found');
  return account;
}

/**
 * El email debe existir y su cuenta pertenecer al usuario.
 * Email se scopea por accountId (no tiene userId propio), así que la
 * verificación de dueño pasa por la Account.
 */
export async function requireOwnedEmail(
  userId: string,
  emailId: string
): Promise<{ email: IEmail; account: IAccount }> {
  const email = await Email.findById(emailId);
  if (!email) throw new OwnershipError('Email not found');
  const account = await Account.findOne({ _id: email.accountId, userId });
  if (!account) throw new OwnershipError('Email not found');
  return { email, account };
}

/**
 * El folder debe existir, pertenecer a `accountId`, y la cuenta al usuario.
 * Asserta `folder.accountId === accountId` para que `accountId` propio +
 * `folderId` de otra cuenta del mismo usuario también dé 404.
 */
export async function requireOwnedFolder(
  userId: string,
  accountId: string,
  folderId: string
): Promise<{ account: IAccount; folder: IFolder }> {
  const account = await requireOwnedAccount(userId, accountId);
  const folder = await Folder.findOne({ _id: folderId, accountId: account._id });
  if (!folder) throw new OwnershipError('Folder not found');
  return { account, folder };
}
