import {
  EC2Client,
  DescribeKeyPairsCommand,
  CreateKeyPairCommand,
  ImportKeyPairCommand,
} from '@aws-sdk/client-ec2';
import { tagSpec } from '../tags.js';

/**
 * Key pair SSH — lo ÚNICO que el CLI hace por SDK fuera de CloudFormation: CFN no devuelve la clave
 * privada (la manda a SSM Parameter Store), así que para entregarle el `.pem` al operador lo creamos
 * acá. El resto del cómputo (SG/EIP/EC2/red) lo declara el stack CloudFormation.
 */
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
