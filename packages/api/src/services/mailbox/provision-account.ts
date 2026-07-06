import { randomBytes } from 'node:crypto';
import { loginOrRegister, type LoginInput } from '../auth.js';
import { getActiveMailboxProvider } from './index.js';
import { ProvisioningDisabledError } from './types.js';

/**
 * Orquestación de alta de cuenta CON provisioning real del buzón. La usan por igual el panel /admin y
 * la API máquina-a-máquina `/api/provision/*` → una sola verdad para: crear el buzón, esperar a que el
 * mailserver lo active, persistir el User+Account (vía `loginOrRegister`, que además verifica IMAP) y
 * hacer ROLLBACK del buzón si algo falla después de crearlo (así un reintento no choca con 409).
 */

export class MailProvisioningNotConfiguredError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'MailProvisioningNotConfiguredError';
  }
}

export interface ProvisionAccountInput {
  email: string;
  /** Si se omite, se genera una contraseña fuerte y se devuelve UNA vez en el resultado. */
  password?: string;
  displayName?: string;
}

export interface ProvisionAccountResult {
  user: Awaited<ReturnType<typeof loginOrRegister>>['user'];
  account: Awaited<ReturnType<typeof loginOrRegister>>['account'];
  isNew: boolean;
  /** La contraseña efectiva del buzón (la enviada o la generada). Mostrar/entregar UNA sola vez. */
  password: string;
  /** true si generamos nosotros la contraseña (para avisarle al operador que la copie). */
  passwordGenerated: boolean;
}

/** Transporte del mailserver propio (docker-mailserver): IMAPS 993 + SMTPS 465, TLS directo. */
function resolveLocalTransport(email: string): Omit<LoginInput, 'password' | 'displayName'> | null {
  const host = (process.env.MAIL_SERVER_HOST ?? '').trim();
  if (!host) return null;
  return {
    email,
    imapHost: host,
    imapPort: 993,
    imapSecure: true,
    smtpHost: host,
    smtpPort: 465,
    smtpSecure: true,
  };
}

/** Contraseña aleatoria fuerte (24 chars base64url, ~144 bits). */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

const READY_TIMEOUT_MS = 30_000;
const READY_INTERVAL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Crea el buzón REAL y registra la cuenta. Requiere que el provider de provisioning esté activo y que
 * `MAIL_SERVER_HOST` esté seteado (sin él no sabemos contra qué IMAP verificar/persistir). Lanza:
 *  - `MailboxExistsError` si el buzón ya existe (el provider),
 *  - `MailProvisioningNotConfiguredError` si el server no está en modo turnkey,
 *  - el error de `loginOrRegister` (con rollback del buzón) si la verificación/persistencia falla.
 */
export async function provisionMailboxAccount(
  input: ProvisionAccountInput
): Promise<ProvisionAccountResult> {
  const email = input.email.trim().toLowerCase();
  const provider = await getActiveMailboxProvider();
  if (provider.type === 'none') throw new ProvisioningDisabledError();
  // Nota: la colisión "email nuevo == alias existente" la verifica `createMailbox` de forma ATÓMICA bajo
  // el lock del provider (lanza AliasConflictError→409); no hace falta un preflight aquí (era racy, review B).

  const transport = resolveLocalTransport(email);
  if (!transport) {
    throw new MailProvisioningNotConfiguredError(
      'Provisioning activo pero MAIL_SERVER_HOST no está configurado; no se puede verificar el buzón nuevo.'
    );
  }

  const trimmed = input.password?.trim();
  const passwordGenerated = !trimmed;
  const password = trimmed && trimmed.length > 0 ? trimmed : generatePassword();

  // 1) Crear el buzón real (lanza MailboxExistsError si ya existe → NO entra al try, no hay rollback).
  await provider.createMailbox(email, password);

  try {
    // 2) Esperar a que el mailserver aplique el cambio (changedetector) y persistir. `loginOrRegister`
    //    verifica IMAP primero: mientras el buzón no está activo devuelve 401 → reintentamos hasta el TTL.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        const res = await loginOrRegister(
          { ...transport, password, displayName: input.displayName },
          { allowAdminBootstrap: false }
        );
        return {
          user: res.user,
          account: res.account,
          isNew: res.isNew,
          password,
          passwordGenerated,
        };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 401 && Date.now() < deadline) {
          await sleep(READY_INTERVAL_MS);
          continue; // buzón aún no activo; reintentar
        }
        throw err;
      }
    }
  } catch (err) {
    // Rollback: el buzón se creó recién pero el alta falló → borrarlo para no dejar un buzón huérfano
    // (sin User/Account) ni bloquear un reintento con 409. Best-effort.
    await provider.deleteMailbox(email).catch(() => undefined);
    throw err;
  }
}
