import type { StackParameter } from '../aws/cloudformation.js';

/**
 * Núcleo PURO del wizard: arma los Parameters del stack a partir de las respuestas. La parte
 * error-prone (mapear respuestas → params CFN, derivar nombre de bucket, defaults) vive acá,
 * testeable sin AWS ni prompts. `ImageId` NO se pasa: usa el default del template (lo resuelve CFN).
 */
export interface WizardAnswers {
  domain: string;
  instanceType: string;
  keyName: string;
  /** Script cloud-init (lo arma buildUserData). */
  userData: string;
  useS3: boolean;
  s3BucketName?: string;
  /** Vacío = crear VPC nueva; con valor = usar esa VPC/subnet. */
  existingVpcId?: string;
  existingSubnetId?: string;
  sshCidr?: string;
}

/** Nombre de bucket derivado del dominio (S3: minúsculas, sin puntos consecutivos, único-ish). */
export function deriveBucketName(domain: string): string {
  const base = domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `bifrost-${base}-data`;
}

export function assembleStackParams(a: WizardAnswers): StackParameter[] {
  return [
    { key: 'DomainName', value: a.domain },
    { key: 'InstanceType', value: a.instanceType },
    { key: 'KeyName', value: a.keyName },
    { key: 'UserData', value: a.userData },
    { key: 'ExistingVpcId', value: a.existingVpcId ?? '' },
    { key: 'ExistingSubnetId', value: a.existingSubnetId ?? '' },
    { key: 'SshCidr', value: a.sshCidr ?? '0.0.0.0/0' },
    { key: 'S3Mode', value: a.useS3 ? 'create' : 'none' },
    { key: 'S3BucketName', value: a.useS3 ? (a.s3BucketName ?? deriveBucketName(a.domain)) : '' },
  ];
}
