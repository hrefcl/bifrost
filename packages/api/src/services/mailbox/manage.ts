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

  if (account.provisionSuspendedLine) {
    // Buzón SUSPENDIDO: no hay línea en accounts.cf, así que setPassword del provider lanzaría "no existe"
    // (502 engañoso: el buzón existe, sólo está suspendido). Reescribimos el hash guardado para que la
    // nueva password aplique al reactivar. Mongo es la única fuente del cambio → si el save falla, 502
    // honesto (nada aplicado). MED-6.
    account.provisionSuspendedLine = provider.buildAccountLine(target, password);
    account.setImapCredentials(password);
    account.setSmtpCredentials(password);
    await account.save();
    return;
  }

  await provider.setPassword(target, password); // side-effect REAL; si falla → 502 (sin cambio aplicado)
  // Sincronizar las credenciales cifradas del webmail. BEST-EFFORT: el password del buzón YA cambió, así
  // que un fallo del save de Mongo NO debe devolver 502 (no re-cambia el password); se re-sincroniza en el
  // próximo login del usuario. MED-4.
  account.setImapCredentials(password);
  account.setSmtpCredentials(password);
  account.status = 'active';
  try {
    await account.save();
  } catch {
    // Password ya aplicada en el mailserver; el sync de credenciales cifradas se recupera al próximo login.
  }
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

  // Orden deliberado: primero las ops del mailserver que pueden FALLAR (→ 409/502) sin haber commiteado
  // Mongo, así un fallo deja el registro intacto. Residual conocido (TD-PROVISION-ATOMIC): displayName
  // vive en otro documento (User) → no es atómico con el Account; aceptable para 1 admin secuencial.
  if (patch.aliases !== undefined) {
    await provider.setAliases(target, patch.aliases); // AliasConflictError → 409; otro fallo → 502
  }
  if (patch.active !== undefined) {
    // Convergemos al estado deseado (no gateamos por el estado actual) → un retry tras un fallo parcial
    // se auto-sana: addRawLine y deleteMailbox son idempotentes.
    if (patch.active) {
      // → ACTIVO: asegurar la línea presente (restaura la password original) y limpiar el campo.
      if (account.provisionSuspendedLine) await provider.addRawLine(account.provisionSuspendedLine);
      account.provisionSuspendedLine = undefined;
      account.status = 'active';
    } else {
      // → SUSPENDIDO: PERSISTIR el hash en Mongo ANTES de borrar la línea del accounts.cf (HIGH-1). Si el
      // save falla, el buzón no se toca; si el delete falla, el hash ya quedó guardado → el retry completa
      // el borrado. Nunca queda sin línea Y sin hash guardado (perdería la password para siempre).
      if (!account.provisionSuspendedLine) {
        const line = await provider.getRawLine(target);
        if (line) account.provisionSuspendedLine = line;
      }
      account.status = 'disabled';
      if (account.provisionSuspendedLine) {
        await account.save();
        await provider.deleteMailbox(target); // sin purgeMaildir (corta IMAP/SMTP; conserva el Maildir)
      }
    }
  }
  if (patch.quotaBytes !== undefined) {
    account.quotaBytes = patch.quotaBytes;
  }
  if (patch.displayName !== undefined) {
    await User.updateOne({ _id: account.userId }, { $set: { displayName: patch.displayName } });
  }
  await account.save();

  const aliases = await provider.getAliases(target).catch(() => []);
  return toMailbox(account, await displayNameFor(account), aliases);
}
