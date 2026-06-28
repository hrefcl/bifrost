import { STSClient } from '@aws-sdk/client-sts';
import { EC2Client } from '@aws-sdk/client-ec2';
import { Route53Client } from '@aws-sdk/client-route-53';

/**
 * Clientes AWS para el preflight. Las credenciales NO se pasan explícitas: se resuelven por la
 * cadena estándar del SDK (env vars, perfil `~/.aws`, rol de instancia…), así no tocamos ni
 * persistimos secretos. La región la elige el operador.
 */
export interface AwsClients {
  sts: STSClient;
  ec2: EC2Client;
  route53: Route53Client;
}

export function makeClients(region: string): AwsClients {
  return {
    sts: new STSClient({ region }),
    ec2: new EC2Client({ region }),
    // Route53 es global, pero el cliente igual requiere una región para firmar.
    route53: new Route53Client({ region }),
  };
}
