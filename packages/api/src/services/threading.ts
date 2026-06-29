import { Email } from '../models/Email.js';

/**
 * Threading de conversaciones (estilo Gmail) por union-find sobre (Message-ID, In-Reply-To,
 * References), scopeado a `accountId` (multi-tenant). Al ingerir un email se busca cualquier email YA
 * en la DB conectado a él —por ancestro (su messageId está en los parents del nuevo) o por descendiente
 * (referencia/responde al nuevo)— y se ADOPTA su threadId; si conecta varios hilos, se mergean a uno
 * canónico. Maneja el orden de llegada IMAP arbitrario (re-linkea orphans) y cadenas de References
 * incompletas (cae a In-Reply-To). Review B 7.5 / D 6.
 *
 * Concurrencia (HIGH de B/D): el cálculo+merge se serializa POR CUENTA con un mutex en proceso, para
 * que dos ingestas del mismo hilo no diverjan. En single-box (una réplica de API) esto es suficiente;
 * multi-réplica necesitaría un lock distribuido (ver TD-THREADING).
 */

const MSGID_RE = /<[^<>\s]+>/g;

/** Extrae los Message-IDs (`<...>`) de un header crudo de References. */
export function parseReferences(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return (raw.match(MSGID_RE) ?? []).map((s) => s.trim());
}

function norm(id: string | undefined | null): string | undefined {
  const t = id?.trim();
  return t && t.length > 0 ? t : undefined;
}

// Mutex por accountId (mismo patrón que el sync por folder): encadena las operaciones de threading de
// una cuenta para serializarlas. El Map crece a lo sumo con el nº de cuentas (acotado).
const locks = new Map<string, Promise<unknown>>();
function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (locks.get(accountId) ?? Promise.resolve()).catch(() => undefined);
  const run = prev.then(fn);
  locks.set(
    accountId,
    run.catch(() => undefined)
  );
  return run;
}

/**
 * Calcula el threadId de un email a punto de ingerirse y MERGEA hilos si conecta varios. Devuelve el
 * threadId canónico. Serializado por cuenta.
 */
export function computeThreadId(
  accountId: string,
  messageId: string,
  inReplyTo: string | undefined | null,
  references: string[]
): Promise<string> {
  return withAccountLock(accountId, async () => {
    const irt = norm(inReplyTo);
    const refs = references.map(norm).filter((x): x is string => !!x);
    const parents = [...new Set([irt, ...refs].filter((x): x is string => !!x))];

    // Emails ya guardados conectados a éste: ancestros (messageId ∈ parents) o descendientes (que
    // referencien/respondan a este messageId — re-linkeo de orphans por orden de llegada arbitrario).
    const or: Record<string, unknown>[] = [{ references: messageId }, { inReplyTo: messageId }];
    if (parents.length) or.push({ messageId: { $in: parents } });
    const connected = await Email.find({ accountId, $or: or })
      .select('threadId')
      .lean<{ threadId?: string }[]>();

    const existing = [...new Set(connected.map((c) => c.threadId).filter((x): x is string => !!x))];
    if (existing.length === 0) {
      // Hilo nuevo: raíz natural = primer reference (más viejo) ?? in-reply-to ?? el propio id.
      return refs.length > 0 ? refs[0] : (irt ?? messageId);
    }
    // Adoptar el hilo existente; si conecta varios, mergear al canónico (determinista = menor).
    existing.sort();
    const canonical = existing[0];
    const others = existing.slice(1);
    if (others.length) {
      await Email.updateMany(
        { accountId, threadId: { $in: others } },
        { $set: { threadId: canonical } }
      );
    }
    return canonical;
  });
}
