import { ProvisionApiKey } from '../models/ProvisionApiKey.js';
import { randomToken, hashToken } from '../config/crypto.js';

/**
 * Gestión de API-keys del provisioning (`/api/provision/*`) desde el panel /admin.
 *
 * El token en claro se genera con entropía alta (160 bits) y sólo se devuelve al CREARLO. En Mongo vive
 * únicamente su hash SHA-256 → una fuga de la DB no revela keys usables. La verificación es un lookup por
 * hash (O(1), sin timing-attack: el atacante no puede afinar sobre el hash de un secreto aleatorio).
 */

const PREFIX = 'bfp_'; // "BiFrost Provisioning" — reconocible en logs/headers.
const PREFIX_DISPLAY_LEN = 12; // cuántos chars del token guardamos para mostrar (prefix + trozo).

export interface ProvisionKeyView {
  id: string;
  label: string;
  prefix: string;
  createdBy: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  active: boolean;
}

function toView(k: {
  _id: unknown;
  label: string;
  prefix: string;
  createdBy: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): ProvisionKeyView {
  return {
    id: String(k._id),
    label: k.label,
    prefix: k.prefix,
    createdBy: k.createdBy,
    lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
    revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
    createdAt: k.createdAt.toISOString(),
    active: k.revokedAt === null,
  };
}

/** Crea una key. Devuelve el token EN CLARO (única vez) + la vista para la lista. */
export async function createProvisionKey(
  label: string,
  createdBy: string
): Promise<{ token: string; key: ProvisionKeyView }> {
  const token = `${PREFIX}${randomToken(20)}`; // bfp_ + 40 hex
  const doc = await ProvisionApiKey.create({
    label: label.trim(),
    tokenHash: hashToken(token),
    prefix: `${token.slice(0, PREFIX_DISPLAY_LEN)}…`,
    createdBy,
  });
  return { token, key: toView(doc) };
}

/** Lista las keys (metadata, SIN hash ni token). Más nuevas primero. */
export async function listProvisionKeys(): Promise<ProvisionKeyView[]> {
  const docs = await ProvisionApiKey.find().sort({ createdAt: -1 }).lean();
  return docs.map(toView);
}

/** Revoca una key (soft-delete). Devuelve false si no existe. Idempotente si ya estaba revocada. */
export async function revokeProvisionKey(id: string): Promise<boolean> {
  const res = await ProvisionApiKey.updateOne(
    { _id: id, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  if (res.matchedCount > 0) return true;
  // Ya revocada cuenta como éxito (idempotente); sólo un id inexistente es false.
  return (await ProvisionApiKey.exists({ _id: id })) !== null;
}

/**
 * Verifica un token contra las keys ACTIVAS (no revocadas). Si matchea, sella `lastUsedAt` y devuelve
 * true. Lookup por hash exacto → no expone timing sobre el secreto.
 */
export async function verifyProvisionKey(token: string): Promise<boolean> {
  if (!token) return false;
  const doc = await ProvisionApiKey.findOneAndUpdate(
    { tokenHash: hashToken(token), revokedAt: null },
    { $set: { lastUsedAt: new Date() } }
  ).lean();
  return doc !== null;
}

/** ¿Existe al menos una key ACTIVA gestionada? (para decidir 404-oculto vs 401 en la ruta máquina). */
export async function hasActiveProvisionKey(): Promise<boolean> {
  return (await ProvisionApiKey.exists({ revokedAt: null })) !== null;
}
