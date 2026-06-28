/**
 * Catálogo CURADO de tipos EC2 para el despliegue ALL-IN-ONE (docker-mailserver + Bifrost:
 * API+web+Mongo+Redis+nginx). El piso real es 4 GB (ClamAV ~1GB + Mongo + Redis + Node no entran
 * en 2 GB). Los precios son APROXIMADOS (on-demand Linux, us-east-1) — sólo orientativos; el precio
 * exacto por región se traerá del Pricing API en una fase futura (marcado como deuda en el diseño).
 */
export interface InstanceTypeInfo {
  type: string;
  vcpu: number;
  memGiB: number;
  /** USD/mes aproximado (on-demand, 730h, us-east-1). Orientativo, NO autoritativo. */
  approxMonthlyUsd: number;
  note: string;
}

export const ALLINONE_CATALOG: readonly InstanceTypeInfo[] = [
  { type: 't3.medium', vcpu: 2, memGiB: 4, approxMonthlyUsd: 30, note: 'Mínimo all-in-one (4 GB)' },
  { type: 't3.large', vcpu: 2, memGiB: 8, approxMonthlyUsd: 60, note: 'Recomendado (cómodo)' },
  {
    type: 't3.xlarge',
    vcpu: 4,
    memGiB: 16,
    approxMonthlyUsd: 120,
    note: 'Holgado / más buzones',
  },
];

export const RECOMMENDED_INSTANCE = 't3.large';

export function recommendInstance(): InstanceTypeInfo {
  const found = ALLINONE_CATALOG.find((i) => i.type === RECOMMENDED_INSTANCE);
  if (!found) throw new Error('Catálogo de instancias inconsistente (falta el recomendado)');
  return found;
}
