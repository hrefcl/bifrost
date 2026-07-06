import { SystemConfig } from '../../models/SystemConfig.js';
import { getActiveMailboxProvider, provisioningEnabled } from './index.js';

/**
 * Catch-all del dominio ("cuenta receptora de todo"): el correo a direcciones INEXISTENTES del dominio
 * (juanito@, basura@, demos sin buzón base) cae en un buzón configurado, en vez de rebotar (los rebotes
 * queman reputación). La fuente de verdad de la CONFIG es este SystemConfig; la materialización (comodín
 * `@dominio` + self-aliases de los buzones reales, para NO desviar su correo) la hace el provider en
 * postfix-virtual.cf. SÓLO modo nativo (docker-mailserver). Ver DockerMailserverProvider.setCatchAll.
 */

const KEY = 'catch-all';

export interface CatchAllConfig {
  enabled: boolean;
  /** Buzón receptor (email real del dominio) cuando `enabled`. */
  target: string | null;
}

/** Error de validación de la config del catch-all (→ 400 en la ruta). */
export class CatchAllError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CatchAllError';
  }
}

export async function getCatchAllConfig(): Promise<CatchAllConfig> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean();
  const raw: unknown = doc?.value ?? {};
  const v = raw as { enabled?: boolean; target?: string | null };
  return { enabled: v.enabled === true, target: v.target ?? null };
}

/**
 * Activa/desactiva/cambia la cuenta receptora. Valida que el target sea un buzón EXISTENTE (autoritativo
 * contra el mailserver, no Mongo). Materializa en el archivo y persiste la config.
 */
export async function setCatchAllConfig(input: {
  enabled: boolean;
  target?: string | null;
}): Promise<CatchAllConfig> {
  if (!(await provisioningEnabled())) {
    throw new CatchAllError('El catch-all requiere provisioning activo (mailserver propio).');
  }
  const provider = await getActiveMailboxProvider();
  const mailboxes = await provider.listMailboxes();
  const real = new Set(mailboxes.map((m) => m.toLowerCase()));

  let target: string | null = null;
  if (input.enabled) {
    const t = input.target?.trim().toLowerCase() ?? '';
    if (!t) throw new CatchAllError('Elegí una cuenta receptora.');
    if (!real.has(t)) throw new CatchAllError('La cuenta receptora debe ser un buzón existente.');
    target = t;
  }
  await provider.setCatchAll(target, mailboxes);
  const value: CatchAllConfig = { enabled: input.enabled, target };
  await SystemConfig.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}

/**
 * Reaplica el catch-all (re-escribe los self-aliases con la lista ACTUAL de buzones) tras crear/borrar un
 * buzón. No-op si está apagado o sin provisioning. Si el buzón receptor ya no existe (fue borrado), APAGA
 * el catch-all para no seguir enviando a un buzón muerto. Best-effort: los callers no deben fallar por esto.
 */
export async function reapplyCatchAll(): Promise<void> {
  if (!(await provisioningEnabled())) return;
  const cfg = await getCatchAllConfig();
  if (!cfg.enabled || !cfg.target) return;
  const provider = await getActiveMailboxProvider();
  const mailboxes = await provider.listMailboxes();
  const real = new Set(mailboxes.map((m) => m.toLowerCase()));
  if (!real.has(cfg.target)) {
    await provider.setCatchAll(null, mailboxes);
    await SystemConfig.findOneAndUpdate(
      { key: KEY },
      { $set: { value: { enabled: false, target: null } } },
      { upsert: true }
    );
    return;
  }
  await provider.setCatchAll(cfg.target, mailboxes);
}
