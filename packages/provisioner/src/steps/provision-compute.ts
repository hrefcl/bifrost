import type { EC2Client } from '@aws-sdk/client-ec2';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { latestUbuntuAmi } from '../aws/ssm.js';
import {
  ensureKeyPair,
  ensureSecurityGroup,
  allocateElasticIp,
  runInstance,
  associateAddress,
} from '../aws/compute.js';
import { addResource, type ProvisionState } from '../state.js';

/**
 * F-E3 (parte 1) — capa de IDENTIDAD/RED del cómputo: resuelve el AMI de Ubuntu, asegura el key pair
 * (crear/importar) y el security group, y los REGISTRA en el state (idempotente: re-correr no
 * duplica). El run de la instancia + EIP es la parte 2. Clientes inyectados → testeable con mocks;
 * deben estar en la REGIÓN DESTINO (el AMI es por-región).
 */
export interface ComputeClients {
  ec2: EC2Client;
  ssm: SSMClient;
}

export interface ComputeInput {
  domain: string;
  keyName: string;
  /** Si se provee, se importa esta clave pública del operador; si no, AWS crea el par. */
  importPublicKey?: string;
  securityGroupName: string;
}

export interface ComputeResult {
  state: ProvisionState;
  amiId: string;
  keyName: string;
  securityGroupId: string;
  /** .pem a guardar 0600 si AWS creó el par; null si se reusó o importó. */
  privateKeyPem: string | null;
}

export async function provisionComputeIdentity(
  clients: ComputeClients,
  input: ComputeInput,
  state: ProvisionState
): Promise<ComputeResult> {
  const amiId = await latestUbuntuAmi(clients.ssm);

  const kp = await ensureKeyPair(clients.ec2, {
    name: input.keyName,
    domain: input.domain,
    importPublicKey: input.importPublicKey,
  });

  const securityGroupId = await ensureSecurityGroup(clients.ec2, {
    name: input.securityGroupName,
    domain: input.domain,
  });

  // AMI NO es un recurso creado (no va al state); key pair y SG sí.
  let next = state;
  next = addResource(next, {
    kind: 'key-pair',
    id: kp.keyName,
    meta: { created: String(kp.created) },
  });
  next = addResource(next, { kind: 'security-group', id: securityGroupId });

  return {
    state: next,
    amiId,
    keyName: kp.keyName,
    securityGroupId,
    privateKeyPem: kp.privateKeyPem,
  };
}

/**
 * F-E3 (parte 2) — lanza la instancia: asegura la Elastic IP, corre el EC2 con el user-data y asocia
 * la IP. RESUMIBLE vía state: reusa la EIP ya asignada (no la duplica) y NO relanza la instancia si
 * ya existe. Idempotencia ANTES de gastar (allocate/run son facturables).
 */
export interface InstanceInput {
  domain: string;
  instanceType: string;
  amiId: string;
  keyName: string;
  securityGroupId: string;
  ebsGiB: number;
  /** Script cloud-init (texto). */
  userData: string;
}

export interface InstanceResult {
  state: ProvisionState;
  instanceId: string;
  allocationId: string;
  publicIp: string;
}

export async function provisionInstance(
  ec2: EC2Client,
  input: InstanceInput,
  state: ProvisionState
): Promise<InstanceResult> {
  let next = state;

  // 1) Elastic IP: reusar la del state si ya se asignó (evita fuga de EIPs en un re-run).
  const existingEip = next.resources.find((r) => r.kind === 'elastic-ip');
  let allocationId: string;
  let publicIp: string;
  if (existingEip) {
    allocationId = existingEip.id;
    publicIp = existingEip.meta?.publicIp ?? '';
  } else {
    const eip = await allocateElasticIp(ec2, input.domain);
    allocationId = eip.allocationId;
    publicIp = eip.publicIp;
    next = addResource(next, { kind: 'elastic-ip', id: allocationId, meta: { publicIp } });
  }

  // 2) Instancia: si ya existe en el state, no relanzar (resumibilidad).
  const existingInstance = next.resources.find((r) => r.kind === 'ec2-instance');
  let instanceId: string;
  if (existingInstance) {
    instanceId = existingInstance.id;
  } else {
    instanceId = await runInstance(ec2, {
      amiId: input.amiId,
      instanceType: input.instanceType,
      keyName: input.keyName,
      securityGroupId: input.securityGroupId,
      ebsGiB: input.ebsGiB,
      userData: input.userData,
      domain: input.domain,
    });
    next = addResource(next, { kind: 'ec2-instance', id: instanceId });
    await associateAddress(ec2, allocationId, instanceId);
  }

  return { state: next, instanceId, allocationId, publicIp };
}
