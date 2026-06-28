import { estimateMonthlyCost, type CostBreakdown } from './cost.js';
import type { ResourceKind } from './state.js';

/**
 * Plan (dry-run): qué recursos se CREARÍAN, en orden, qué factura y el costo estimado — TODO sin
 * tocar AWS. Es la pantalla de confirmación antes de crear nada. PURA → testeable.
 */
export interface PlanInput {
  region: string;
  domain: string;
  mailHostname: string;
  useS3: boolean;
  bucketName?: string;
  instanceType: string;
  instanceMonthlyUsd: number;
  ebsGiB: number;
  /** Correo bulk a almacenar en S3 (si useS3). */
  bulkGiB: number;
  mailboxes: number;
  /** Crear una hosted zone nueva (vs usar una existente/padre). */
  createHostedZone: boolean;
  /** Cifrar el EBS raíz con la CMK (requiere KMS aunque no se use S3). */
  encryptEbs: boolean;
}

export interface PlanStep {
  kind: ResourceKind;
  title: string;
  /** Si genera cargo recurrente en AWS. */
  billable: boolean;
  detail: string;
}

export interface ProvisionPlan {
  steps: PlanStep[];
  cost: CostBreakdown;
}

export function buildPlan(input: PlanInput): ProvisionPlan {
  const steps: PlanStep[] = [];
  const needsKms = input.useS3 || input.encryptEbs;

  if (needsKms) {
    steps.push({
      kind: 'kms-key',
      title: 'KMS CMK',
      billable: true,
      detail: 'clave de cifrado (S3/EBS), rotación anual',
    });
  }
  if (input.useS3) {
    steps.push({
      kind: 's3-bucket',
      title: `S3 bucket ${input.bucketName ?? ''}`.trim(),
      billable: true,
      detail: 'block-public, SSE-KMS, versioning, policy deny-unencrypted/no-TLS',
    });
  }
  steps.push({
    kind: 'key-pair',
    title: 'Key pair SSH',
    billable: false,
    detail: 'importada o creada (.pem 0600)',
  });
  steps.push({
    kind: 'security-group',
    title: 'Security group',
    billable: false,
    detail: 'puertos 22/25/465/587/143/993/80/443',
  });
  steps.push({
    kind: 'elastic-ip',
    title: 'Elastic IP',
    billable: true,
    detail: 'IP pública estable para MX/PTR',
  });
  steps.push({
    kind: 'ec2-instance',
    title: `EC2 ${input.instanceType}`,
    billable: true,
    detail: `${String(input.ebsGiB)}GB EBS gp3${needsKms ? ' cifrado' : ''}; user-data: docker-mailserver + Bifrost (reusa deploy/example-mailserver)`,
  });
  if (input.createHostedZone) {
    steps.push({
      kind: 'route53-zone',
      title: `Route53 zone ${input.domain}`,
      billable: true,
      detail: 'se creará; deberás apuntar los NS en tu registrador',
    });
  }
  steps.push({
    kind: 'route53-record',
    title: 'Registros DNS',
    billable: false,
    detail: `A ${input.mailHostname}, MX, SPF, DMARC, DKIM`,
  });

  const cost = estimateMonthlyCost({
    instanceMonthlyUsd: input.instanceMonthlyUsd,
    ebsGiB: input.ebsGiB,
    s3GiB: input.useS3 ? input.bulkGiB : 0,
    dataTransferOutGiB: 50,
    mailboxes: input.mailboxes,
    createHostedZone: input.createHostedZone,
    useKms: needsKms,
  });

  return { steps, cost };
}
