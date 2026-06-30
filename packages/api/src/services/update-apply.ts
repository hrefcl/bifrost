import { writeFileSync, renameSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lado API del update Fase 2: deja un MARKER de "actualizar" que el host-updater (fuera del contenedor)
 * lee y aplica con pull+up+rollback. El API NUNCA toca el socket de Docker. Ver bifrost-update.sh.
 *
 * HARDENING (review B/D): el target lo determina el SERVIDOR (el sha del último build, de checkForUpdate),
 * NO el cliente → no se puede pedir un tag arbitrario. El sha se re-valida acá con regex estricta antes de
 * escribir el marker (el host-updater lo vuelve a validar: defensa en profundidad). Escritura ATÓMICA.
 */
// Leído POR LLAMADA (no al cargar el módulo) → respeta cambios de env y es testeable sin re-import.
function triggerDir(): string {
  return process.env.UPDATE_TRIGGER_DIR ?? '/app/update-trigger';
}
const SHA_RE = /^[0-9a-f]{7,40}$/;

export interface UpdateState {
  status: 'idle' | 'in_progress' | 'succeeded' | 'failed' | 'rolledback';
  from?: string;
  to?: string;
  reason?: string;
}

/** Encola un update al build `sha` (el host-updater lo aplica). Valida el sha. Devuelve el tag escrito. */
export function requestUpdate(sha: string): string {
  if (!SHA_RE.test(sha)) throw new Error(`sha inválido: ${sha}`);
  const tag = `sha-${sha}`;
  mkdirSync(triggerDir(), { recursive: true });
  const target = join(triggerDir(), 'requested');
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${tag}\n`, { mode: 0o640 });
  renameSync(tmp, target); // atómico
  return tag;
}

/** Lee el estado del update que dejó el host-updater (o 'idle' si no hay). */
export function getUpdateState(): UpdateState {
  try {
    const raw = readFileSync(join(triggerDir(), 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdateState>;
    if (parsed.status) return parsed as UpdateState;
  } catch {
    /* sin estado → idle */
  }
  return { status: 'idle' };
}

/** ¿Hay un update ya en curso? (evita re-encolar mientras corre — idempotencia). */
export function isUpdateInProgress(): boolean {
  return getUpdateState().status === 'in_progress';
}
