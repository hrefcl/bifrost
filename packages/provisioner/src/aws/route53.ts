import { Route53Client, ListHostedZonesCommand } from '@aws-sdk/client-route-53';

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
