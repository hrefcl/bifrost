import {
  Route53Client,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
  type Change,
  type RRType,
} from '@aws-sdk/client-route-53';

export interface HostedZone {
  /** Id sin el prefijo `/hostedzone/`. */
  id: string;
  /** Nombre en minúsculas, con punto final (como lo devuelve Route53). */
  name: string;
}

/**
 * Lista TODAS las hosted zones PÚBLICAS de la cuenta (paginado completo). Sólo públicas: las
 * privadas no sirven el DNS de correo en internet. Paginar es necesario porque una cuenta puede
 * tener >100 zonas y la zona buscada podría no estar en la primera página.
 */
export async function listPublicHostedZones(r53: Route53Client): Promise<HostedZone[]> {
  const zones: HostedZone[] = [];
  let marker: string | undefined;
  do {
    const res = await r53.send(new ListHostedZonesCommand(marker ? { Marker: marker } : {}));
    for (const z of res.HostedZones ?? []) {
      if (z.Id && z.Name && z.Config?.PrivateZone !== true) {
        zones.push({ id: z.Id.replace('/hostedzone/', ''), name: z.Name.toLowerCase() });
      }
    }
    marker = res.IsTruncated ? res.NextMarker : undefined;
  } while (marker);
  return zones;
}

/** Un ResourceRecordSet EXISTENTE en la zona, en su forma mínima (name FQDN minúsculas, type). */
export interface ExistingRecord {
  name: string;
  type: string;
}

/**
 * Lista los ResourceRecordSets EXISTENTES de una zona (paginado completo). Sólo (name,type) — es lo único
 * que necesita el pre-flight de DNS para detectar choques con los registros que va a crear el stack. El
 * paginado usa el cursor compuesto (NextRecordName, NextRecordType) que exige Route53. name en minúsculas.
 */
export async function listResourceRecordSets(
  r53: Route53Client,
  hostedZoneId: string
): Promise<ExistingRecord[]> {
  const out: ExistingRecord[] = [];
  let startName: string | undefined;
  let startType: RRType | undefined;
  for (;;) {
    const res = await r53.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        StartRecordName: startName,
        StartRecordType: startType,
      })
    );
    for (const rr of res.ResourceRecordSets ?? []) {
      if (rr.Name && rr.Type) out.push({ name: rr.Name.toLowerCase(), type: rr.Type });
    }
    if (res.IsTruncated && res.NextRecordName) {
      startName = res.NextRecordName;
      startType = res.NextRecordType;
    } else {
      break;
    }
  }
  return out;
}

export interface HostedZoneMatch {
  /** Zona cuyo nombre es EXACTAMENTE el dominio. */
  exact: HostedZone | null;
  /** Zona PADRE que contiene el dominio (sufijo con borde de label), si no hay exacta. */
  parent: HostedZone | null;
}

/**
 * Resuelve, para un dominio, si hay una zona exacta o una zona PADRE que lo contenga. PURA
 * (testeable sin AWS). El borde de label (prefijo ".") evita falsos positivos tipo
 * "ample.com" ⊃ "example.com".
 */
export function matchHostedZone(zones: readonly HostedZone[], domain: string): HostedZoneMatch {
  const fqdn = (domain.endsWith('.') ? domain : `${domain}.`).toLowerCase();
  const exact = zones.find((z) => z.name === fqdn) ?? null;
  if (exact) return { exact, parent: null };
  const parent =
    zones
      .filter((z) => fqdn.endsWith(`.${z.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null;
  return { exact: null, parent };
}

/** Un record DNS genérico (lo producen ses-identity.dkimCnameRecords / mailFromRecords). */
export interface DnsUpsert {
  name: string;
  type: 'CNAME' | 'MX' | 'TXT' | 'A';
  value: string;
  ttl: number;
}

/**
 * Agrupa records por (name,type) en Changes UPSERT. PURA. Necesario porque Route53 modela un
 * ResourceRecordSet por (name,type) con N valores — dos records del mismo name+type van en el MISMO set
 * (si se mandaran como Changes separados, el segundo PISA al primero).
 */
export function toUpsertChanges(records: readonly DnsUpsert[]): Change[] {
  const byKey = new Map<string, { rec: DnsUpsert; values: string[] }>();
  for (const r of records) {
    const key = `${r.name.toLowerCase()}|${r.type}`;
    const entry = byKey.get(key);
    if (entry) entry.values.push(r.value);
    else byKey.set(key, { rec: r, values: [r.value] });
  }
  return [...byKey.values()].map(({ rec, values }) => ({
    Action: 'UPSERT',
    ResourceRecordSet: {
      Name: rec.name,
      Type: rec.type,
      TTL: rec.ttl,
      ResourceRecords: values.map((Value) => ({ Value })),
    },
  }));
}

/**
 * Crea/actualiza records en una hosted zone (UPSERT → idempotente: re-correr no duplica ni falla).
 * Si no hay records, no llama a la API.
 */
export async function upsertRecords(
  r53: Route53Client,
  hostedZoneId: string,
  records: readonly DnsUpsert[]
): Promise<void> {
  const changes = toUpsertChanges(records);
  if (changes.length === 0) return;
  await r53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: { Changes: changes },
    })
  );
}
