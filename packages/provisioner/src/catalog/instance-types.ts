/**
 * Catálogo CURADO de tipos EC2 para el despliegue ALL-IN-ONE (docker-mailserver + Bifrost:
 * API+web+Mongo+Redis+nginx). El piso real es 4 GB (ClamAV ~1GB + Mongo + Redis + Node no entran
 * en 2 GB). Los precios son APROXIMADOS (on-demand Linux, us-east-1) — sólo orientativos; el precio
 * exacto por región se traerá del Pricing API en una fase futura (marcado como deuda en el diseño).
 */
export type CpuArch = 'arm64' | 'amd64';

export interface InstanceTypeInfo {
  type: string;
  vcpu: number;
  memGiB: number;
  arch: CpuArch;
  /** USD/mes aproximado (on-demand, 730h, us-east-1). Orientativo, NO autoritativo. */
  approxMonthlyUsd: number;
  note: string;
}

// Default = Graviton (ARM/t4g): ~18-20% más barato que t3 (x86) a iguales vCPU/RAM. Las imágenes
// docker del stack son multi-arch (manifest list amd64+arm64), así que corren igual en ARM.
export const ALLINONE_CATALOG: readonly InstanceTypeInfo[] = [
  {
    type: 't4g.medium',
    vcpu: 2,
    memGiB: 4,
    arch: 'arm64',
    approxMonthlyUsd: 24,
    note: 'Mínimo all-in-one (4 GB, Graviton)',
  },
  {
    type: 't4g.large',
    vcpu: 2,
    memGiB: 8,
    arch: 'arm64',
    approxMonthlyUsd: 49,
    note: 'Recomendado (cómodo, Graviton)',
  },
  {
    type: 't4g.xlarge',
    vcpu: 4,
    memGiB: 16,
    arch: 'arm64',
    approxMonthlyUsd: 98,
    note: 'Holgado / más buzones (Graviton)',
  },
];

export const RECOMMENDED_INSTANCE = 't4g.large';

export function recommendInstance(): InstanceTypeInfo {
  const found = ALLINONE_CATALOG.find((i) => i.type === RECOMMENDED_INSTANCE);
  if (!found) throw new Error('Catálogo de instancias inconsistente (falta el recomendado)');
  return found;
}

/**
 * Arquitectura de CUALQUIER tipo de instancia (incluido un override x86 fuera del catálogo). Las
 * familias Graviton llevan el sufijo `g` en la familia (t4g, m6g, c7g, r6gd, c6gn…) → arm64; el
 * resto (t3, m5, c6i…) → amd64. Sirve para pasar el AMI SSM correcto y no terminar con un mismatch
 * instancia↔AMI (arm64 image en x86 host = la instancia no bootea).
 */
export function archForInstanceType(type: string): CpuArch {
  return /^[a-z]+\d+g[a-z]*\./i.test(type) ? 'arm64' : 'amd64';
}
