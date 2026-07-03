import { randomBytes } from 'node:crypto';
import { Account, type IAccount } from '../../models/Account.js';
import { User } from '../../models/User.js';
import { getActiveMailboxProvider } from './index.js';

/**
 * Gestión CRUD de buzones para la API máquina-a-máquina (`/api/provision/*`). Bifrost es la autoridad:
 * el `Account` de Mongo es la fuente de verdad del registro (email, displayName, cuota, estado, alias
 * guardados) y el provider (docker-mailserver) aplica el lado mail-server (password, línea, alias).
 */

/** Shape consistente devuelto por list/get/create/patch. */
export interface Mailbox {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'suspended';
  quotaBytes: number;
  quotaUsedBytes: number;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
}

export class MailboxNotFoundError extends Error {
  constructor(email: string) {
    super(`El buzón ${email} no existe.`);
    this.name = 'MailboxNotFoundError';
  }
}

/** Contraseña aleatoria fuerte (24 chars base64url, ~144 bits). */
export function generateMailboxPassword(): string {
  return randomBytes(18).toString('base64url');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toMailbox(account: IAccount, displayName: string | undefined, aliases: string[]): Mailbox {
  return {
    id: String(account._id),
    email: account.email,
    displayName: displayName ?? account.name,
    // `provisionSuspendedLine` presente ⇒ suspendido (la línea del accounts.cf está guardada, no activa).
    status: account.provisionSuspendedLine ? 'suspended' : 'active',
    quotaBytes: account.quotaBytes ?? 0,
    // MVP: el uso real vive en el Maildir del mailserver (doveadm). Sin ese dato montado → 0.
    quotaUsedBytes: 0,
    aliases,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

async function displayNameFor(account: IAccount): Promise<string | undefined> {
  const u = await User.findById(account.userId).select('displayName').lean();
  return u?.displayName;
}

/** Buzón por email → modelo, o null. */
export async function getMailbox(email: string): Promise<Mailbox | null> {
  const account = await Account.findOne({ email: email.trim().toLowerCase() });
  if (!account) return null;
  const provider = await getActiveMailboxProvider();
  const aliases = await provider.getAliases(account.email).catch(() => []);
  return toMailbox(account, await displayNameFor(account), aliases);
}

/** Lista paginada + búsqueda (por email o displayName). Fuente: colección Account. */
export async function listMailboxes(opts: {
  page: number;
  pageSize: number;
  search?: string;
}): Promise<{ items: Mailbox[]; total: number; page: number; pageSize: number }> {
  const { page, pageSize } = opts;
  const search = opts.search?.trim();
  let filter: Record<string, unknown> = {};
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const users = await User.find({ displayName: rx }).select('_id').lean();
    filter = { $or: [{ email: rx }, { userId: { $in: users.map((u) => u._id) } }] };
  }
  const total = await Account.countDocuments(filter);
  const accounts = await Account.find(filter)
    .sort({ email: 1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize);
  const users = await User.find({ _id: { $in: accounts.map((a) => a.userId) } })
    .select('displayName')
    .lean();
  const nameById = new Map(users.map((u) => [String(u._id), u.displayName]));
  const provider = await getActiveMailboxProvider();
  const items = await Promise.all(
    accounts.map(async (a) =>
      toMailbox(
        a,
        nameById.get(String(a.userId)),
        await provider.getAliases(a.email).catch(() => [])
      )
    )
  );
  return { items, total, page, pageSize };
}

/** Cambia la contraseña del buzón (mailserver) + refresca las credenciales guardadas del webmail. */
export async function setMailboxPassword(email: string, password: string): Promise<void> {
  const target = email.trim().toLowerCase();
  const account = await Account.findOne({ email: target });
  if (!account) throw new MailboxNotFoundError(target);
  const provider = await getActiveMailboxProvider();
  await provider.setPassword(target, password); // lanza si falla el mailserver → 502 en la ruta
  // Mantener sincronizadas las credenciales cifradas que usa el webmail (si no, el sync falla hasta el
  // próximo login). Best-effort: el cambio de password del buzón ya se aplicó.
  account.setImapCredentials(password);
  account.setSmtpCredentials(password);
  account.status = 'active';
  await account.save();
}

/** Resetea la contraseña: genera una fuerte, la fija y la devuelve UNA vez. */
export async function resetMailboxPassword(
  email: string,
  password?: string
): Promise<{ email: string; password: string }> {
  const trimmed = password?.trim();
  const pw = trimmed && trimmed.length > 0 ? trimmed : generateMailboxPassword();
  await setMailboxPassword(email, pw);
  return { email: email.trim().toLowerCase(), password: pw };
}

/** Edita perfil del buzón: displayName, quotaBytes, aliases, active (suspender/reactivar). */
export async function patchMailbox(
  email: string,
  patch: {
    displayName?: string;
    quotaBytes?: number;
    aliases?: string[];
    active?: boolean;
  }
): Promise<Mailbox> {
  const target = email.trim().toLowerCase();
  const account = await Account.findOne({ email: target });
  if (!account) throw new MailboxNotFoundError(target);
  const provider = await getActiveMailboxProvider();

  if (patch.displayName !== undefined) {
    await User.updateOne({ _id: account.userId }, { $set: { displayName: patch.displayName } });
  }
  if (patch.quotaBytes !== undefined) {
    account.quotaBytes = patch.quotaBytes;
  }
  if (patch.aliases !== undefined) {
    await provider.setAliases(target, patch.aliases); // puede lanzar → 502
  }
  if (patch.active !== undefined) {
    const suspendedLine = account.provisionSuspendedLine;
    if (patch.active && suspendedLine) {
      // Reactivar: restaurar la línea guardada (conserva la password original).
      await provider.addRawLine(suspendedLine);
      account.provisionSuspendedLine = undefined;
      account.status = 'active';
    } else if (!patch.active && !suspendedLine) {
      // Suspender: guardar la línea y quitarla del accounts.cf (corta IMAP/SMTP; no borra el Maildir).
      const line = await provider.getRawLine(target);
      if (line) {
        account.provisionSuspendedLine = line;
        await provider.deleteMailbox(target); // sin purgeMaildir
      }
      account.status = 'disabled';
    }
  }
  await account.save();

  const aliases = await provider.getAliases(target).catch(() => []);
  return toMailbox(account, await displayNameFor(account), aliases);
}
