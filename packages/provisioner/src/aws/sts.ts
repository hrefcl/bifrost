import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

export interface AwsIdentity {
  accountId: string;
  arn: string;
  userId: string;
}

/** Valida las credenciales AWS resolviendo la identidad del llamador (read-only, no factura). */
export async function validateCredentials(sts: STSClient): Promise<AwsIdentity> {
  const res = await sts.send(new GetCallerIdentityCommand({}));
  if (!res.Account || !res.Arn || !res.UserId) {
    throw new Error('Respuesta de STS incompleta (credenciales inválidas)');
  }
  return { accountId: res.Account, arn: res.Arn, userId: res.UserId };
}
