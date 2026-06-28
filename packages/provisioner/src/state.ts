/**
 * Estado de aprovisionamiento (F-E2): registra QUÉ recursos creó el CLI para que el proceso sea
 * IDEMPOTENTE (no recrear lo existente), RESUMIBLE (continuar tras un fallo) y DESTRUIBLE
 * (teardown sabe exactamente qué borrar). Se persiste como JSON; NUNCA guarda secretos (claves AWS,
 * secret de SMTP, etc.) — sólo ids de recursos y metadata no sensible.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** Tipos de recurso AWS que el provisioner crea, en ORDEN canónico de creación (dependencias). */
export const RESOURCE_ORDER = [
  'kms-key',
  's3-bucket',
  'key-pair',
  'security-group',
  'elastic-ip',
  'ec2-instance',
  'route53-zone',
  'route53-record',
] as const;

export type ResourceKind = (typeof RESOURCE_ORDER)[number];

export interface ResourceRef {
  kind: ResourceKind;
  /** Id físico / nombre (instanceId, bucket, allocationId, hostedZoneId, "TYPE name"…). */
  id: string;
  region?: string;
  /** Metadata no sensible (p. ej. createdByUs:'true' para zonas que creamos nosotros). */
  meta?: Record<string, string>;
}

export interface ProvisionState {
  version: 1;
  region: string;
  domain: string;
  resources: ResourceRef[];
}

export function emptyState(region: string, domain: string): ProvisionState {
  return { version: 1, region, domain, resources: [] };
}

/** Agrega (o reemplaza, dedup por kind+id) un recurso. Inmutable: devuelve un nuevo estado. */
export function addResource(state: ProvisionState, ref: ResourceRef): ProvisionState {
  const resources = state.resources.filter((r) => !(r.kind === ref.kind && r.id === ref.id));
  resources.push(ref);
  return { ...state, resources };
}

export function removeResource(
  state: ProvisionState,
  kind: ResourceKind,
  id: string
): ProvisionState {
  return { ...state, resources: state.resources.filter((r) => !(r.kind === kind && r.id === id)) };
}

/** ¿Existe ya un recurso de este kind (opcionalmente con ese id)? Para idempotencia. */
export function hasResource(state: ProvisionState, kind: ResourceKind, id?: string): boolean {
  return state.resources.some((r) => r.kind === kind && (id === undefined || r.id === id));
}

export function serializeState(state: ProvisionState): string {
  return JSON.stringify(state, null, 2);
}

/** Persiste el state (0600 — referencia ids de recursos; mantener acotado, sin secretos). */
export function saveState(path: string, state: ProvisionState): void {
  writeFileSync(path, serializeState(state), { mode: 0o600 });
}

/** Carga el state; null si no existe (primera corrida). Lanza si está corrupto (NO lo trata vacío). */
export function loadState(path: string): ProvisionState | null {
  if (!existsSync(path)) return null;
  return parseState(readFileSync(path, 'utf8'));
}

/** Parsea + VALIDA forma/versión (un state corrupto no debe interpretarse como vacío y borrar/recrear). */
export function parseState(json: string): ProvisionState {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== 'object' || raw === null) throw new Error('state inválido: no es un objeto');
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) throw new Error(`state: versión no soportada (${String(obj.version)})`);
  if (typeof obj.region !== 'string' || typeof obj.domain !== 'string') {
    throw new Error('state: faltan region/domain');
  }
  if (!Array.isArray(obj.resources)) throw new Error('state: resources no es un array');
  const kinds = new Set<string>(RESOURCE_ORDER);
  const resources: ResourceRef[] = obj.resources.map((r, i) => {
    if (typeof r !== 'object' || r === null)
      throw new Error(`state: resource[${String(i)}] inválido`);
    const rr = r as Record<string, unknown>;
    if (typeof rr.kind !== 'string' || !kinds.has(rr.kind)) {
      throw new Error(`state: resource[${String(i)}].kind inválido`);
    }
    if (typeof rr.id !== 'string') throw new Error(`state: resource[${String(i)}].id inválido`);
    return {
      kind: rr.kind as ResourceKind,
      id: rr.id,
      ...(typeof rr.region === 'string' ? { region: rr.region } : {}),
      ...(rr.meta && typeof rr.meta === 'object'
        ? { meta: rr.meta as Record<string, string> }
        : {}),
    };
  });
  return { version: 1, region: obj.region, domain: obj.domain, resources };
}
