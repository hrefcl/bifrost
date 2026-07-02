/**
 * Catálogo CURADO de tipos EC2 para el despliegue ALL-IN-ONE (docker-mailserver + Bifrost:
 * API+web+Mongo+Redis+nginx, y opcionalmente LiveKit/Meet). El piso real es 4 GB (ClamAV ~1GB + Mongo +
 * Redis + Node no entran en 2 GB). Los precios son APROXIMADOS (on-demand Linux, us-east-1) — sólo
 * orientativos; el precio exacto por región se traerá del Pricing API en una fase futura (deuda).
 *
 * CAPACIDAD (maxMailboxes / meetConcurrent): estimaciones CONSERVADORAS y orientativas para dimensionar,
 * NO límites duros. El correo escala con RAM (working set de Mongo + conexiones IMAP) y vCPU (escaneo
 * antispam/antivirus); los adjuntos van a S3, así que el disco no es el cuello. Meet self-hosted (LiveKit
 * SFU) es CPU-bound DURANTE las llamadas y comparte el EC2 → activarlo reduce los buzones cómodos y suma
 * el techo de participantes simultáneos en llamada. OJO: las familias `t4g` son BURSTABLE (CPU por
 * créditos) → una llamada sostenida agota los créditos; los `meetConcurrent` son para llamadas cortas/
 * livianas y conviene validar con load test. Para Meet INTENSIVO usá LiveKit EXTERNO (no compite con el
 * correo) o una familia no-burstable (m/c/r) vía "Otro" — ver el modo `external` del wizard.
 */
export type CpuArch = 'arm64' | 'amd64';

export interface InstanceTypeInfo {
  type: string;
  vcpu: number;
  memGiB: number;
  arch: CpuArch;
  /** USD/mes aproximado (on-demand, 730h, us-east-1). Orientativo, NO autoritativo. */
  approxMonthlyUsd: number;
  /** Buzones/empleados cómodos SOLO-CORREO (estimación conservadora, no límite duro). */
  maxMailboxes: number;
  /** Participantes simultáneos en llamada con Meet BUNDLED (LiveKit en el mismo EC2). 0 = no apto para
   *  Meet self-hosted (RAM <8 GiB). Con Meet activo, los buzones cómodos bajan (~la mitad). */
  meetConcurrent: number;
  note: string;
}

// Default = Graviton (ARM/t4g): ~18-20% más barato que t3 (x86) a iguales vCPU/RAM. Las imágenes docker
// del stack son multi-arch (manifest list amd64+arm64), así que corren igual en ARM.
export const ALLINONE_CATALOG: readonly InstanceTypeInfo[] = [
  {
    type: 't4g.medium',
    vcpu: 2,
    memGiB: 4,
    arch: 'arm64',
    approxMonthlyUsd: 24,
    maxMailboxes: 15,
    meetConcurrent: 0,
    note: 'Mínimo — equipos chicos / prueba (4 GB). No apto para Meet self-hosted.',
  },
  {
    type: 't4g.large',
    vcpu: 2,
    memGiB: 8,
    arch: 'arm64',
    approxMonthlyUsd: 49,
    maxMailboxes: 50,
    meetConcurrent: 8,
    note: 'Recomendado — PYME típica (8 GB). Meet: llamadas chicas (~8 participantes, burstable).',
  },
  {
    type: 't4g.xlarge',
    vcpu: 4,
    memGiB: 16,
    arch: 'arm64',
    approxMonthlyUsd: 98,
    maxMailboxes: 150,
    meetConcurrent: 20,
    note: 'Empresa mediana (16 GB). Meet: llamadas medianas (~20 participantes, burstable).',
  },
  {
    type: 't4g.2xlarge',
    vcpu: 8,
    memGiB: 32,
    arch: 'arm64',
    approxMonthlyUsd: 196,
    maxMailboxes: 500,
    meetConcurrent: 45,
    note: 'Empresa grande — ~500 buzones (32 GB). Meet: ~45 participantes (burstable; para Meet intensivo usá LiveKit externo).',
  },
];

export const RECOMMENDED_INSTANCE = 't4g.large';

/** Piso de RAM (GiB) y tipo mínimo cuando Bifrost Meet BUNDLED está activo (PM). */
export const MEET_MIN_MEM_GIB = 8;
export const MEET_INSTANCE_FLOOR = 't4g.large';

export function recommendInstance(): InstanceTypeInfo {
  const found = ALLINONE_CATALOG.find((i) => i.type === RECOMMENDED_INSTANCE);
  if (!found) throw new Error('Catálogo de instancias inconsistente (falta el recomendado)');
  return found;
}

/**
 * Recomienda la instancia MÁS CHICA del catálogo que cubre `mailboxes` buzones (y, si Meet bundled está
 * activo, que además sea apta para Meet — ≥8 GiB, meetConcurrent>0). Con Meet, la capacidad de buzones
 * cómodos baja ~la mitad (el SFU comparte CPU/RAM), así que se compara contra `maxMailboxes/2`. Si ningún
 * tipo alcanza, devuelve el MÁS GRANDE con `exceedsCatalog=true` (el wizard sugiere escalar o LiveKit
 * externo). Determinística y pura. */
export function recommendInstanceFor(
  mailboxes: number,
  meetBundled: boolean
): { instance: InstanceTypeInfo; exceedsCatalog: boolean } {
  // Con Meet bundled, elegible = apto para Meet: ≥8 GiB Y meetConcurrent>0 (ambas condiciones, no una sola
  // por la otra — robustez si a futuro divergen). Ordenado ascendente por RAM para que `find` dé el más chico.
  const eligible = (
    meetBundled
      ? ALLINONE_CATALOG.filter((i) => i.memGiB >= MEET_MIN_MEM_GIB && i.meetConcurrent > 0)
      : [...ALLINONE_CATALOG]
  )
    .slice()
    .sort((a, b) => a.maxMailboxes - b.maxMailboxes);
  const capacity = (i: InstanceTypeInfo): number =>
    meetBundled ? Math.floor(i.maxMailboxes / 2) : i.maxMailboxes;
  const fit = eligible.find((i) => capacity(i) >= mailboxes);
  if (fit) return { instance: fit, exceedsCatalog: false };
  const largest = eligible[eligible.length - 1];
  return { instance: largest, exceedsCatalog: true };
}

/** Etiqueta humana para el menú de selección: specs + costo + a cuántos usuarios apunta. */
export function describeInstanceChoice(i: InstanceTypeInfo, meetBundled: boolean): string {
  const users = meetBundled ? Math.floor(i.maxMailboxes / 2) : i.maxMailboxes;
  const meetPart = meetBundled ? `, ~${String(i.meetConcurrent)} en llamada` : '';
  return `${i.type} — ${String(i.vcpu)} vCPU / ${String(i.memGiB)} GiB — ~$${String(i.approxMonthlyUsd)}/mes — hasta ~${String(users)} buzones${meetPart}`;
}

/**
 * Aplica el PISO de instancia cuando Bifrost Meet BUNDLED está activo: LiveKit (media SFU) + mailserver +
 * Mongo + ClamAV en el MISMO EC2 no entran en <8 GiB. Si el tipo elegido es de CATÁLOGO y tiene <8 GiB, lo
 * sube al piso (`t4g.large`). Un override FUERA de catálogo se respeta (no se puede introspectar la RAM sin
 * la API de EC2) — el caller debe AVISAR en ese caso. Devuelve `{type, bumped, unknownBelowFloor}`:
 * `bumped` si se subió; `unknownBelowFloor` si es un tipo desconocido. Idempotente.
 */
export function enforceMeetInstanceFloor(type: string): {
  type: string;
  bumped: boolean;
  unknownBelowFloor: boolean;
} {
  const info = ALLINONE_CATALOG.find((i) => i.type === type);
  if (info) {
    if (info.memGiB < MEET_MIN_MEM_GIB)
      return { type: MEET_INSTANCE_FLOOR, bumped: true, unknownBelowFloor: false };
    return { type, bumped: false, unknownBelowFloor: false };
  }
  // Tipo fuera del catálogo: lo respetamos pero señalamos que no podemos garantizar el piso de RAM.
  return { type, bumped: false, unknownBelowFloor: true };
}

/**
 * Arquitectura de CUALQUIER tipo de instancia (incluido un override x86 fuera del catálogo). Las familias
 * Graviton llevan el sufijo `g` en la familia (t4g, m6g, c7g, r6gd, c6gn…) → arm64; el resto (t3, m5,
 * c6i…) → amd64. Sirve para pasar el AMI SSM correcto y no terminar con un mismatch instancia↔AMI (arm64
 * image en x86 host = la instancia no bootea). Distingue g5 (x86, NVIDIA) de g5g (Graviton) y g4dn (x86)
 * de t4g (Graviton). Único falso negativo conocido: `a1` (Graviton1, sin `g` en la familia) → amd64; es
 * deprecada y el catálogo no la ofrece. [D]
 */
export function archForInstanceType(type: string): CpuArch {
  return /^[a-z]+\d+g[a-z]*\./i.test(type) ? 'arm64' : 'amd64';
}

/**
 * Catálogo CURADO para el media-box de Bifrost Meet (modo twobox). FILOSOFÍA: "separar, NO duplicar" — si
 * bundled corría mail + LiveKit juntos en 1× t4g.large (8 GiB), al SEPARAR cada mitad es más liviana → el
 * media-box (SÓLO LiveKit, ~1-2 GiB) entra cómodo en `t4g.medium` (4 GiB, ~$24). Así el 2-box mínimo =
 * 2× t4g.medium (~$48) ≈ el costo de 1× t4g.large bundled, pero con la media separada del correo. Default
 * `t4g.medium` (MÍNIMO). LiveKit SFU es CPU-bound: para MUCHAS llamadas sostenidas se escala a t4g.large o
 * c6g/c7g (no burstable). Precios aproximados (on-demand Linux, us-east-1).
 */
export const LIVEKIT_CATALOG: readonly InstanceTypeInfo[] = [
  {
    type: 't4g.small',
    vcpu: 2,
    memGiB: 2,
    arch: 'arm64',
    approxMonthlyUsd: 12,
    maxMailboxes: 0, // no aplica al media-box
    meetConcurrent: 6,
    note: 'ULTRA-MÍNIMO (~$12) — LiveKit pide ~1 GiB y usa la MISMA 2 vCPU que los t4g grandes (CPU-bound). Entra en 2 GiB; RAM justa en el boot (pull+apt). Sólo llamadas 1-a-1/chicas ocasionales — validá con tu carga.',
  },
  {
    type: 't4g.medium',
    vcpu: 2,
    memGiB: 4,
    arch: 'arm64',
    approxMonthlyUsd: 24,
    maxMailboxes: 0, // no aplica al media-box
    meetConcurrent: 8,
    note: 'MÍNIMO SEGURO — 2-box económico, llamadas chicas/ocasionales (4 GiB dan margen sobre LiveKit).',
  },
  {
    type: 't4g.large',
    vcpu: 2,
    memGiB: 8,
    arch: 'arm64',
    approxMonthlyUsd: 49,
    maxMailboxes: 0, // no aplica al media-box
    meetConcurrent: 12,
    note: 'Holgado — más margen de RAM (burstable; para carga sostenida usá c6g/c7g).',
  },
  {
    type: 'c6g.large',
    vcpu: 2,
    memGiB: 4,
    arch: 'arm64',
    approxMonthlyUsd: 58,
    maxMailboxes: 0,
    meetConcurrent: 15,
    note: 'CPU-optimizado no-burstable — mejor SFU sostenido que t4g.large.',
  },
  {
    type: 'c6g.xlarge',
    vcpu: 4,
    memGiB: 8,
    arch: 'arm64',
    approxMonthlyUsd: 116,
    maxMailboxes: 0,
    meetConcurrent: 35,
    note: 'Media empresa — llamadas medianas/grandes sin competir con el correo.',
  },
  {
    type: 'c7g.large',
    vcpu: 2,
    memGiB: 4,
    arch: 'arm64',
    approxMonthlyUsd: 54,
    maxMailboxes: 0,
    meetConcurrent: 18,
    note: 'Graviton3, CPU-optimizado — rendimiento por vCPU superior a c6g.',
  },
];

// t4g.small (2 GiB, ~$12) VALIDADO en AWS real (2026-07-01): LiveKit + Caddy usan ~330 MB, 1.3 GiB libres,
// token validado por el media-box, sin swap. LiveKit es CPU-bound (~1 GiB RAM) → 2 GiB alcanzan de sobra.
export const DEFAULT_LIVEKIT_INSTANCE = 't4g.small';

/** Etiqueta humana para el menú del media-box. */
export function describeLivekitInstanceChoice(i: InstanceTypeInfo): string {
  return `${i.type} — ${String(i.vcpu)} vCPU / ${String(i.memGiB)} GiB — ~$${String(i.approxMonthlyUsd)}/mes — ~${String(i.meetConcurrent)} participantes simultáneos`;
}

/** Recomienda la instancia de media-box más chica que cubre `participants` participantes. */
export function recommendLivekitInstanceFor(participants: number): {
  instance: InstanceTypeInfo;
  exceedsCatalog: boolean;
} {
  const eligible = [...LIVEKIT_CATALOG].sort((a, b) => a.meetConcurrent - b.meetConcurrent);
  const fit = eligible.find((i) => i.meetConcurrent >= participants);
  if (fit) return { instance: fit, exceedsCatalog: false };
  const largest = eligible[eligible.length - 1];
  return { instance: largest, exceedsCatalog: true };
}
