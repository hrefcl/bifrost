import { Account } from '../../models/Account.js';
import { User } from '../../models/User.js';
import { getActiveMailboxProvider, provisioningEnabled } from './index.js';

/**
 * Reconciliación de buzones: IMPORTA a Bifrost los buzones que ya existen en el servidor de correo pero
 * que Bifrost no tiene registrados. Caso brownfield real (migración desde Roundcube/altas manuales): el
 * mailserver puede tener N buzones, pero Bifrost sólo registra los que se crearon POR Bifrost o los que
 * iniciaron sesión al menos una vez (loginOrRegister crea el Account on-the-fly). Sin esto, esos buzones
 * son INVISIBLES en el panel y NO se pueden gestionar (borrar/suspender/cambiar clave), porque todo el
 * CRUD (`/admin/accounts`, `/api/provision/*`) mira la colección Account de Mongo, no el accounts.cf.
 *
 * La importación crea un "shell": User + Account SIN credenciales de webmail (no conocemos la contraseña
 * en claro; en accounts.cf sólo vive el hash bcrypt). Esto es suficiente para GESTIONAR el buzón —
 * suspender/borrar/cambiar-clave operan sobre la LÍNEA del mailserver vía el provider, no sobre las
 * credenciales cifradas del webmail. El shell se auto-vincula cuando:
 *   - el usuario inicia sesión (loginOrRegister hace upsert por email → rellena credenciales), o
 *   - el admin le fija/resetea la contraseña (setMailboxPassword escribe credenciales cifradas).
 *
 * Idempotente: reejecutar sólo importa los que falten. Las credenciales VACÍAS (`ciphertext:''`) son la
 * señal de "sin vincular"; el barrido de sincronización las SALTA (ver syncStaleAccounts) para no
 * intentar IMAP con credenciales inexistentes ni monopolizar el barrido.
 */

export interface ReconcileMailboxesResult {
  /** Buzones reales en el servidor (accounts.cf). */
  serverTotal: number;
  /** Cuántos ya estaban registrados en Bifrost antes de importar. */
  alreadyTracked: number;
  /** Cuántos se importaron ahora. */
  imported: number;
  /** Emails importados en esta corrida. */
  importedEmails: string[];
  /**
   * HUÉRFANOS: cuentas registradas en Bifrost (Mongo) cuyo buzón YA NO existe en el servidor (accounts.cf)
   * — típicamente porque una gestión externa borró el buzón fuera de Bifrost. Se REPORTAN, no se borran:
   * eliminar un Account arrastra su correo/carpetas indexados, y esa decisión (¿fue borrado a propósito o
   * es un desfase temporal?) es del operador. Se limpian con un DELETE explícito (`/admin/accounts/:id` o
   * `/api/provision/mailboxes/:email`), que es idempotente aunque el buzón ya no esté en el servidor.
   */
  orphans: string[];
}

/**
 * Crea el shell User+Account de un buzón importado. Upsert por email/primaryEmail (idempotente y
 * race-safe, mismo patrón que loginOrRegister) y sin `$set` de credenciales: quedan vacías hasta el
 * primer login o el reset de contraseña. NUNCA otorga admin (rol por defecto 'user').
 */
async function importOneMailbox(email: string, host: string): Promise<void> {
  const displayName = email.split('@')[0] || email;
  const user = await User.findOneAndUpdate(
    { primaryEmail: email },
    { $setOnInsert: { primaryEmail: email, displayName } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await Account.findOneAndUpdate(
    { email },
    {
      $setOnInsert: {
        userId: user._id,
        name: email,
        email,
        isPrimary: true,
        // El buzón está ACTIVO en el servidor (por eso 'active', no 'disabled': 'disabled' significa
        // suspendido). Sin credenciales de webmail todavía → el barrido de sync lo salta por ciphertext''.
        status: 'active',
        imap: {
          host,
          port: 993,
          secure: true,
          authMethod: 'password',
          authUser: email,
          authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
          compress: false,
          preferredProtocol: 'imap',
        },
        smtp: {
          host,
          port: 465,
          secure: true,
          authMethod: 'password',
          authUser: email,
          authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Importa a Bifrost todos los buzones del servidor que aún no estén registrados. No-op (sin importar)
 * si el provisioning no está activo (sin mailserver-como-autoridad no hay accounts.cf que leer). Lanza
 * si el provisioning está activo pero falta `MAIL_SERVER_HOST` (no podríamos construir un Account válido:
 * `imap.host` es requerido).
 */
export async function reconcileMailboxes(): Promise<ReconcileMailboxesResult> {
  const tracked = await Account.countDocuments();
  if (!(await provisioningEnabled())) {
    // Sin provisioning Bifrost no es la autoridad de cuentas (modo bring-your-own): no hay accounts.cf.
    return {
      serverTotal: 0,
      alreadyTracked: tracked,
      imported: 0,
      importedEmails: [],
      orphans: [],
    };
  }
  const host = (process.env.MAIL_SERVER_HOST ?? '').trim();
  if (!host) {
    throw new Error(
      'Provisioning activo pero MAIL_SERVER_HOST no está configurado; no se pueden importar buzones.'
    );
  }
  const provider = await getActiveMailboxProvider();
  const real = [...new Set((await provider.listMailboxes()).map((e) => e.trim().toLowerCase()))];
  const realSet = new Set(real);
  const existing = new Set(
    (await Account.find().select('email').lean()).map((a) => a.email.toLowerCase())
  );
  const missing = real.filter((e) => e && !existing.has(e));
  // Huérfanos: en Mongo pero NO en el servidor (buzón borrado fuera de Bifrost). Solo se reportan.
  const orphans = [...existing].filter((e) => e && !realSet.has(e)).sort();

  const importedEmails: string[] = [];
  for (const email of missing) {
    await importOneMailbox(email, host);
    importedEmails.push(email);
  }

  return {
    serverTotal: real.length,
    alreadyTracked: existing.size,
    imported: importedEmails.length,
    importedEmails,
    orphans,
  };
}

/**
 * Cuenta los buzones reales del servidor (accounts.cf) para mostrar el total real en el panel y detectar
 * el desfase con Bifrost. Devuelve null si el provisioning no está activo o si falla la lectura (no es un
 * error fatal para el listado — sólo se omite el contador).
 */
export async function countServerMailboxes(): Promise<number | null> {
  if (!(await provisioningEnabled())) return null;
  try {
    const provider = await getActiveMailboxProvider();
    return (await provider.listMailboxes()).length;
  } catch {
    return null;
  }
}
