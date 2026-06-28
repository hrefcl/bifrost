import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * AMI más reciente de Ubuntu 22.04 LTS (amd64) — Canonical publica el id como parámetro SSM PÚBLICO,
 * así siempre tomamos la imagen parcheada al día (en vez de hardcodear un id que se pudre). El id es
 * POR REGIÓN: este `SSMClient` debe estar en la región DESTINO, no en la de control.
 */
const UBUNTU_2204_PARAM =
  '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id';

export async function latestUbuntuAmi(ssm: SSMClient): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: UBUNTU_2204_PARAM }));
  const id = res.Parameter?.Value;
  if (!id) throw new Error('No se pudo resolver el AMI de Ubuntu 22.04 vía SSM');
  return id;
}
