import {
  EC2Client,
  DescribeKeyPairsCommand,
  CreateKeyPairCommand,
  ImportKeyPairCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  AllocateAddressCommand,
  AssociateAddressCommand,
  RunInstancesCommand,
  type RunInstancesCommandInput,
} from '@aws-sdk/client-ec2';
import { tagSpec } from '../tags.js';

/** Puertos que el servidor de correo + web necesitan abiertos. */
export const MAIL_PORTS = [22, 25, 80, 443, 143, 465, 587, 993] as const;

export interface KeyPairResult {
  keyName: string;
  /** Material privado SÓLO cuando lo crea AWS (hay que guardarlo como .pem 0600). null si se reusó/importó. */
  privateKeyPem: string | null;
  created: boolean;
}

/**
 * Idempotente: si el key pair ya existe lo reusa (no puede re-descargar la clave privada). Si se
 * pasa `importPublicKey`, importa la pública del operador; si no, AWS crea el par y devuelve el .pem.
 */
export async function ensureKeyPair(
  ec2: EC2Client,
  opts: { name: string; domain: string; importPublicKey?: string }
): Promise<KeyPairResult> {
  const existing = await ec2
    .send(new DescribeKeyPairsCommand({ KeyNames: [opts.name] }))
    .catch(() => null); // InvalidKeyPair.NotFound → no existe
  if (existing?.KeyPairs && existing.KeyPairs.length > 0) {
    return { keyName: opts.name, privateKeyPem: null, created: false };
  }
  if (opts.importPublicKey) {
    await ec2.send(
      new ImportKeyPairCommand({
        KeyName: opts.name,
        PublicKeyMaterial: new TextEncoder().encode(opts.importPublicKey),
        TagSpecifications: [tagSpec('key-pair', opts.domain)],
      })
    );
    return { keyName: opts.name, privateKeyPem: null, created: true };
  }
  const res = await ec2.send(
    new CreateKeyPairCommand({
      KeyName: opts.name,
      TagSpecifications: [tagSpec('key-pair', opts.domain)],
    })
  );
  if (!res.KeyMaterial) throw new Error('CreateKeyPair no devolvió KeyMaterial');
  return { keyName: opts.name, privateKeyPem: res.KeyMaterial, created: true };
}

/**
 * Idempotente por nombre: si el SG existe devuelve su id; si no lo crea y abre los puertos de correo.
 * SSH (22) queda abierto a 0.0.0.0/0 por simplicidad de turnkey — restringir a la IP del operador
 * es una mejora registrada (deuda LOW de seguridad).
 */
export async function ensureSecurityGroup(
  ec2: EC2Client,
  opts: { name: string; domain: string; vpcId?: string }
): Promise<string> {
  const found = await ec2
    .send(
      new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [opts.name] }] })
    )
    .catch(() => null);
  const existingId = found?.SecurityGroups?.[0]?.GroupId;
  if (existingId) return existingId;

  const created = await ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: opts.name,
      Description: 'Bifrost mail + web (managed by bifrost-provision)',
      ...(opts.vpcId ? { VpcId: opts.vpcId } : {}),
      TagSpecifications: [tagSpec('security-group', opts.domain)],
    })
  );
  const groupId = created.GroupId;
  if (!groupId) throw new Error('CreateSecurityGroup no devolvió GroupId');

  await ec2.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: MAIL_PORTS.map((p) => ({
        IpProtocol: 'tcp',
        FromPort: p,
        ToPort: p,
        IpRanges: [{ CidrIp: '0.0.0.0/0' }],
      })),
    })
  );
  return groupId;
}

export interface ElasticIp {
  allocationId: string;
  publicIp: string;
}

/** Asigna una Elastic IP (IP pública estable para MX/PTR). */
export async function allocateElasticIp(ec2: EC2Client, domain: string): Promise<ElasticIp> {
  const res = await ec2.send(
    new AllocateAddressCommand({
      Domain: 'vpc',
      TagSpecifications: [tagSpec('elastic-ip', domain)],
    })
  );
  if (!res.AllocationId || !res.PublicIp)
    throw new Error('AllocateAddress devolvió datos incompletos');
  return { allocationId: res.AllocationId, publicIp: res.PublicIp };
}

export interface RunInstanceOpts {
  amiId: string;
  instanceType: string;
  keyName: string;
  securityGroupId: string;
  ebsGiB: number;
  /** Script cloud-init (texto plano; se codifica base64 acá). */
  userData: string;
  domain: string;
}

/**
 * Lanza UNA instancia EC2 con el AMI/tipo dados, EBS gp3 CIFRADO (clave EBS por defecto si no se pasa
 * CMK) y el user-data (cloud-init) en base64. Devuelve el instanceId.
 */
export async function runInstance(ec2: EC2Client, opts: RunInstanceOpts): Promise<string> {
  const input: RunInstancesCommandInput = {
    ImageId: opts.amiId,
    InstanceType: opts.instanceType as RunInstancesCommandInput['InstanceType'],
    KeyName: opts.keyName,
    SecurityGroupIds: [opts.securityGroupId],
    MinCount: 1,
    MaxCount: 1,
    BlockDeviceMappings: [
      {
        DeviceName: '/dev/sda1', // raíz en las AMIs de Ubuntu
        Ebs: {
          VolumeSize: opts.ebsGiB,
          VolumeType: 'gp3',
          DeleteOnTermination: true,
          Encrypted: true,
        },
      },
    ],
    UserData: Buffer.from(opts.userData, 'utf8').toString('base64'),
    TagSpecifications: [tagSpec('instance', opts.domain)],
  };
  const res = await ec2.send(new RunInstancesCommand(input));
  const id = res.Instances?.[0]?.InstanceId;
  if (!id) throw new Error('RunInstances no devolvió InstanceId');
  return id;
}

/** Asocia la Elastic IP a la instancia (IP pública fija). */
export async function associateAddress(
  ec2: EC2Client,
  allocationId: string,
  instanceId: string
): Promise<void> {
  await ec2.send(
    new AssociateAddressCommand({ AllocationId: allocationId, InstanceId: instanceId })
  );
}
