import { STSClient } from '@aws-sdk/client-sts';
import { EC2Client } from '@aws-sdk/client-ec2';
import { Route53Client } from '@aws-sdk/client-route-53';

/**
 * Clientes AWS para el preflight. Las credenciales NO se pasan explícitas: se resuelven por la
 * cadena estándar del SDK (env vars, perfil `~/.aws`, rol de instancia…), así no tocamos ni
 * persistimos secretos.
 *
 * IMPORTANTE: la región de estos clientes es la de CONTROL (estable, default us-east-1), NO la
 * región DESTINO que elige el operador. Si usáramos la región destino y fuera rara/no habilitada,
 * las llamadas de control (STS/DescribeRegions) podrían fallar y voltear todo el preflight. La
 * región destino se VALIDA como dato contra DescribeRegions; no se usa para firmar estas llamadas.
 */
export interface AwsClients {
  sts: STSClient;
  ec2: EC2Client;
  route53: Route53Client;
}

export function makeClients(controlRegion = 'us-east-1'): AwsClients {
  return {
    sts: new STSClient({ region: controlRegion }),
    ec2: new EC2Client({ region: controlRegion }),
    // Route53 es global, pero el cliente igual requiere una región para firmar.
    route53: new Route53Client({ region: controlRegion }),
  };
}
