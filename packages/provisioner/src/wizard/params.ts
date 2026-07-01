import type { StackParameter } from '../aws/cloudformation.js';
import { archForInstanceType, type CpuArch } from '../catalog/instance-types.js';
import { sesParamName } from '../ses/naming.js';

/** Path SSM del AMI Ubuntu 22.04 más reciente para una arquitectura (CFN lo resuelve al deploy). */
export function ubuntuAmiSsmPath(arch: CpuArch): string {
  return `/aws/service/canonical/ubuntu/server/22.04/stable/current/${arch}/hvm/ebs-gp2/ami-id`;
}

/**
 * Núcleo PURO del wizard: arma los Parameters del stack a partir de las respuestas. La parte
 * error-prone (mapear respuestas → params CFN, derivar nombre de bucket, defaults) vive acá,
 * testeable sin AWS ni prompts. `ImageId` se pasa EXPLÍCITO según la arch de la instancia (Graviton
 * arm64 vs x86 amd64) para no terminar con un mismatch instancia↔AMI.
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
  /** Zona Route53 para gestionar el DNS desde el stack (opt-in). Vacío = no tocar DNS. */
  hostedZoneId?: string;
  /** Habilitar Bifrost Meet (LiveKit): 2º SG (puertos media), A meet./turn.meet., EIP→node_ip, piso. */
  enableMeet?: boolean;
  /** Habilitar outbound SES: da al rol del box permiso de leer la credencial SMTP de SSM. */
  enableSes?: boolean;
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
    { key: 'ImageId', value: ubuntuAmiSsmPath(archForInstanceType(a.instanceType)) },
    { key: 'KeyName', value: a.keyName },
    // UserData NO va como parámetro: se EMBEBE en el template (buildStackTemplate(userData)) porque un
    // parámetro String de CFN tope a 4096 chars y el cloud-init son ~5KB. [bug del deploy real]
    { key: 'ExistingVpcId', value: a.existingVpcId ?? '' },
    { key: 'ExistingSubnetId', value: a.existingSubnetId ?? '' },
    { key: 'SshCidr', value: a.sshCidr ?? '0.0.0.0/0' },
    { key: 'S3Mode', value: a.useS3 ? 'create' : 'none' },
    { key: 'S3BucketName', value: a.useS3 ? (a.s3BucketName ?? deriveBucketName(a.domain)) : '' },
    { key: 'HostedZoneId', value: a.hostedZoneId ?? '' },
    // 'enabled' activa el 2º SG (puertos media LiveKit), los A meet./turn.meet. y la inyección de la
    // EIP en node_ip. Default 'disabled' → base byte-idéntica (instalación funciona igual con Meet OFF).
    { key: 'MeetMode', value: a.enableMeet ? 'enabled' : 'disabled' },
    // SES on → el rol del box puede leer la credencial SMTP de ESTE parámetro (mismo nombre que escribe
    // el orquestador y lee el user-data). Vacío = outbound SES off.
    { key: 'SesParamName', value: a.enableSes ? sesParamName(a.domain) : '' },
  ];
}
