import { validateCredentials, type AwsIdentity } from '../aws/sts.js';
import { listRegions } from '../aws/ec2.js';
import { findHostedZone } from '../aws/route53.js';
import type { AwsClients } from '../aws/clients.js';
import { validateDomain, mailHostname } from '../domain.js';
import { validateBucketName } from '../s3-naming.js';
import { recommendInstance, type InstanceTypeInfo } from '../catalog/instance-types.js';

export interface PreflightInput {
  region: string;
  domain: string;
  /** Si se usará S3 (SSE-KMS) como repositorio de datos cifrado de Bifrost. */
  useS3: boolean;
  bucketName?: string;
}

export interface PreflightResult {
  identity: AwsIdentity;
  region: { value: string; valid: boolean };
  recommendedInstance: InstanceTypeInfo;
  domain: {
    value: string;
    valid: boolean;
    mailHostname: string;
    hostedZoneId: string | null;
    hostedZoneExists: boolean;
  };
  s3: {
    enabled: boolean;
    bucketName: string | null;
    bucketNameValid: boolean;
    bucketNameReason?: string;
  };
  /** Avisos no fatales que el operador debe revisar antes de aprovisionar. */
  warnings: string[];
}

/**
 * Preflight READ-ONLY: valida credenciales, región, dominio (+ hosted zone Route53) y nombre de
 * bucket S3. NO crea nada ni factura. Devuelve un resultado estructurado + avisos; el CLI lo
 * presenta y decide si continuar. Recibe los clientes inyectados → testeable con mocks del SDK.
 */
export async function runPreflight(
  clients: AwsClients,
  input: PreflightInput
): Promise<PreflightResult> {
  const warnings: string[] = [];

  const identity = await validateCredentials(clients.sts);

  const regions = await listRegions(clients.ec2);
  const regionValid = regions.includes(input.region);
  if (!regionValid) {
    warnings.push(`La región "${input.region}" no está habilitada en la cuenta.`);
  }

  const domainValid = validateDomain(input.domain);
  let hostedZoneId: string | null = null;
  if (domainValid) {
    const zone = await findHostedZone(clients.route53, input.domain);
    hostedZoneId = zone?.id ?? null;
    if (!zone) {
      warnings.push(
        `No existe hosted zone Route53 para ${input.domain}; se creará y deberás apuntar los NS en tu registrador.`
      );
    }
  } else {
    warnings.push(`El dominio "${input.domain}" no es un FQDN válido.`);
  }

  let bucketNameValid = false;
  let bucketNameReason: string | undefined;
  if (input.useS3) {
    const check = validateBucketName(input.bucketName ?? '');
    bucketNameValid = check.valid;
    bucketNameReason = check.reason;
    if (!check.valid) {
      warnings.push(`Nombre de bucket S3 inválido: ${check.reason ?? 'desconocido'}.`);
    }
  }

  return {
    identity,
    region: { value: input.region, valid: regionValid },
    recommendedInstance: recommendInstance(),
    domain: {
      value: input.domain,
      valid: domainValid,
      mailHostname: domainValid ? mailHostname(input.domain) : '',
      hostedZoneId,
      hostedZoneExists: hostedZoneId !== null,
    },
    s3: {
      enabled: input.useS3,
      bucketName: input.useS3 ? (input.bucketName ?? null) : null,
      bucketNameValid,
      bucketNameReason,
    },
    warnings,
  };
}
