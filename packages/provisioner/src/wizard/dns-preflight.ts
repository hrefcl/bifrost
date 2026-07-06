/**
 * Pre-flight de DNS (pieza PURA y testeable). Cuando el operador elige "gestionar el DNS desde el stack",
 * el CFN crea RecordSets con `AWS::Route53::RecordSet` que FALLAN si un registro con el mismo (name,type) YA
 * existe en la zona → CloudFormation hace ROLLBACK de TODO el stack (los 2 EC2, VPC, etc.). Es un footgun
 * real (hallado en el deploy from-zero de aulion.dev, que ya tenía SPF/DMARC de un setup previo). Cierra
 * TD-DNS-EXISTING-RECORDS-ROLLBACK.
 *
 * Este módulo NO llama a AWS ni decide la UX (skip/borrar/upsert): sólo (1) computa los registros que el
 * stack va a crear y (2) los cruza contra los existentes para reportar conflictos. El caller (CLI) decide
 * qué hacer con el resultado. Así la lógica queda cubierta por unit tests sin mockear Route53.
 */

/** Un registro DNS identificado por su clave única en Route53: (name FQDN con punto final, type). */
export interface DnsRecordKey {
  /** Nombre FQDN normalizado con punto final (como los devuelve Route53), en minúsculas. */
  name: string;
  type: 'A' | 'MX' | 'TXT';
}

/** Normaliza un nombre DNS a la forma canónica de Route53: minúsculas + punto final. */
export function normalizeDnsName(name: string): string {
  const n = name.trim().toLowerCase();
  return n.endsWith('.') ? n : `${n}.`;
}

/**
 * Registros que el stack CREA cuando se gestiona el DNS (deben coincidir EXACTO con el recurso `DnsRecords`
 * de `stack-template.ts`: A mail, A webmail, MX apex, TXT apex (SPF), TXT _dmarc; y con Meet DNS: A meet,
 * A turn.meet). Si el template cambia, actualizar acá (hay un test que ancla la lista).
 */
export function plannedDnsRecords(
  domain: string,
  opts: { manageMeetDns: boolean }
): DnsRecordKey[] {
  const d = domain.trim().toLowerCase();
  const recs: DnsRecordKey[] = [
    { name: normalizeDnsName(`mail.${d}`), type: 'A' },
    { name: normalizeDnsName(`webmail.${d}`), type: 'A' },
    { name: normalizeDnsName(d), type: 'MX' },
    { name: normalizeDnsName(d), type: 'TXT' }, // SPF en el apex
    { name: normalizeDnsName(`_dmarc.${d}`), type: 'TXT' },
  ];
  if (opts.manageMeetDns) {
    recs.push({ name: normalizeDnsName(`meet.${d}`), type: 'A' });
    recs.push({ name: normalizeDnsName(`turn.meet.${d}`), type: 'A' });
  }
  return recs;
}

/**
 * Cruza los registros que el stack va a crear contra los que YA existen en la zona y devuelve los que
 * CHOCAN (mismo name+type). Route53 identifica un RecordSet por (name,type), así que un choque = el CFN
 * `RecordSet` CREATE fallaría con "already exists" → rollback. Comparación case-insensitive + FQDN-normalizada.
 */
export function findDnsConflicts(
  planned: readonly DnsRecordKey[],
  existing: readonly DnsRecordKey[]
): DnsRecordKey[] {
  const existingSet = new Set(existing.map((r) => `${normalizeDnsName(r.name)}|${r.type}`));
  return planned.filter((p) => existingSet.has(`${normalizeDnsName(p.name)}|${p.type}`));
}
