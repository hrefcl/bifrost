import { Route53Client, ListHostedZonesByNameCommand } from '@aws-sdk/client-route-53';

export interface HostedZoneMatch {
  /** Id sin el prefijo `/hostedzone/`. */
  id: string;
  /** Nombre con punto final, como lo devuelve Route53. */
  name: string;
}

/** Busca una hosted zone EXACTA para el dominio. null si no existe (el flujo ofrecerá crearla). */
export async function findHostedZone(
  r53: Route53Client,
  domain: string
): Promise<HostedZoneMatch | null> {
  const target = (domain.endsWith('.') ? domain : `${domain}.`).toLowerCase();
  const res = await r53.send(new ListHostedZonesByNameCommand({ DNSName: target }));
  const zone = (res.HostedZones ?? []).find((z) => z.Name?.toLowerCase() === target);
  if (!zone?.Id || !zone.Name) return null;
  return { id: zone.Id.replace('/hostedzone/', ''), name: zone.Name };
}
