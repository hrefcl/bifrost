import {
  EC2Client,
  DescribeKeyPairsCommand,
  CreateKeyPairCommand,
  ImportKeyPairCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
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
