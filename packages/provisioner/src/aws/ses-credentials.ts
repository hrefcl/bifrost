import {
  IAMClient,
  GetUserCommand,
  CreateUserCommand,
  PutUserPolicyCommand,
  ListAccessKeysCommand,
  CreateAccessKeyCommand,
  DeleteAccessKeyCommand,
} from '@aws-sdk/client-iam';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { deriveSesSmtpPassword, sesSmtpHost } from './ses-smtp.js';
import { sesConfigSetName } from '../ses/naming.js';

/**
 * Ciclo de vida de las credenciales SMTP de SES — la pieza de seguridad crítica del outbound turnkey.
 * Ver docs/diseno-ses-turnkey.md §3/§7. Garantías:
 *   - El SecretAccessKey de AWS NUNCA se persiste ni sale del CLI: se deriva en memoria al password SMTP
 *     y al box sólo viaja ese password (SSM SecureString). [B-HIGH#1]
 *   - IDEMPOTENTE: re-correr converge (no duplica keys ni reescribe si ya hay credencial vigente).
 *   - CRASH-SAFE: si un run anterior murió entre CreateAccessKey y el PutParameter, queda una key activa
 *     huérfana (no referenciada por SSM). Al inicio de CADA run se reconcilia: se borran las keys que no
 *     coinciden con la vigente en SSM. Así el re-run sana el estado aun tras un kill -9. [B/D-MED]
 *   - TRANSACCIONAL: si el PutParameter falla, se borra la key recién creada (cero huérfanas). [B/D-MED]
 *   - LÍMITE DE 2 KEYS de IAM: las huérfanas se limpian primero, así nunca se choca el tope al crear.
 */

/** Lo que se guarda en SSM (SecureString): el operador del box arma RELAY_USER/RELAY_PASSWORD con esto. */
export interface SmtpCredential {
  accessKeyId: string;
  smtpPassword: string;
}

export interface EnsureSmtpCredentialsInput {
  iam: IAMClient;
  ssm: SSMClient;
  /** Región de SES (define el endpoint SMTP y entra en la derivación del password). */
  region: string;
  /** Nombre determinístico del IAM user, p.ej. `bifrost-ses-acme-com`. */
  userName: string;
  /** Nombre de la policy inline (scoped a ses:SendRawEmail del dominio). */
  policyName: string;
  /** Documento de policy JSON (lo arma el llamador con buildSesSendPolicy). */
  policyDocument: string;
  /** Nombre del parámetro SSM SecureString donde vive la credencial. */
  ssmParamName: string;
  /** CMK de KMS para cifrar el SecureString (o `alias/aws/ssm` si no se da una propia). */
  kmsKeyId?: string;
  /** Tags para rastrear el recurso en teardown/status. */
  tags?: { Key: string; Value: string }[];
}

export interface EnsureSmtpCredentialsResult {
  userName: string;
  accessKeyId: string;
  smtpHost: string;
  ssmParamName: string;
  /** true si se creó/rotó una credencial nueva en este run; false si ya había una vigente (idempotente). */
  created: boolean;
}

/** Policy inline mínima: enviar SOLO desde el dominio dado, scoped a la identidad SES. [B/D-MED] */
export function buildSesSendPolicy(region: string, accountId: string, domain: string): string {
  const base = `arn:aws:ses:${region}:${accountId}`;
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['ses:SendRawEmail', 'ses:SendEmail'],
        // DOS recursos: la IDENTIDAD **y** el CONFIGURATION SET. El config-set es el default de la
        // identidad (§6), así que SES evalúa el permiso de envío TAMBIÉN sobre el config-set → sin su ARN
        // el envío rebota `554 Access denied ... configuration-set` (bug hallado en el e2e real desde 0).
        // Scopear el Resource a esta identidad ya restringe el envío a ESTE dominio (reemplaza la antigua
        // Condition FromAddress); un leak sólo puede mandar as aulion.app, no as cualquier identidad. [B/D]
        Resource: [
          `${base}:identity/${domain}`,
          `${base}:configuration-set/${sesConfigSetName(domain)}`,
        ],
      },
    ],
  });
}

async function ensureUser(input: EnsureSmtpCredentialsInput): Promise<void> {
  const { iam, userName, tags } = input;
  try {
    await iam.send(new GetUserCommand({ UserName: userName }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'NoSuchEntityException') throw err;
    await iam.send(new CreateUserCommand({ UserName: userName, Tags: tags }));
  }
  // Idempotente: PutUserPolicy crea o reemplaza la policy inline con el mismo nombre.
  await iam.send(
    new PutUserPolicyCommand({
      UserName: userName,
      PolicyName: input.policyName,
      PolicyDocument: input.policyDocument,
    })
  );
}

async function readSsmCredential(ssm: SSMClient, name: string): Promise<SmtpCredential | null> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const raw = res.Parameter?.Value;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SmtpCredential>;
    if (!parsed.accessKeyId || !parsed.smtpPassword) return null;
    return { accessKeyId: parsed.accessKeyId, smtpPassword: parsed.smtpPassword };
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') return null;
    throw err;
  }
}

export async function ensureSmtpCredentials(
  input: EnsureSmtpCredentialsInput
): Promise<EnsureSmtpCredentialsResult> {
  const { iam, ssm, region, userName, ssmParamName, kmsKeyId } = input;
  const smtpHost = sesSmtpHost(region);

  await ensureUser(input);

  // Credencial vigente según SSM (la fuente de verdad de "cuál key está en uso").
  const current = await readSsmCredential(ssm, ssmParamName);

  // Reconciliación crash-safe: borrar TODA key activa que no sea la vigente (huérfanas de crashes o
  // rotaciones a medio terminar). Esto también deja lugar bajo el tope de 2 keys de IAM.
  const keys =
    (await iam.send(new ListAccessKeysCommand({ UserName: userName }))).AccessKeyMetadata ?? [];
  for (const k of keys) {
    if (!k.AccessKeyId) continue;
    // Borra cualquier key que no sea la vigente en SSM (si no hay vigente, current?.accessKeyId es
    // undefined y se borran todas → limpieza total de huérfanas).
    if (k.AccessKeyId !== current?.accessKeyId) {
      await iam.send(
        new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: k.AccessKeyId })
      );
    }
  }

  // Si la vigente sobrevivió a la limpieza, es idempotente: no creamos nada nuevo.
  if (current && keys.some((k) => k.AccessKeyId === current.accessKeyId)) {
    return { userName, accessKeyId: current.accessKeyId, smtpHost, ssmParamName, created: false };
  }

  // Crear credencial fresca, derivar el password EN MEMORIA y guardarlo en SSM. Si SSM falla, borrar la
  // key recién creada (transaccional → cero huérfanas).
  const created = await iam.send(new CreateAccessKeyCommand({ UserName: userName }));
  const accessKeyId = created.AccessKey?.AccessKeyId;
  const secret = created.AccessKey?.SecretAccessKey;
  if (!accessKeyId || !secret) throw new Error('CreateAccessKey no devolvió la credencial');

  const smtpPassword = deriveSesSmtpPassword(secret, region);
  const value: SmtpCredential = { accessKeyId, smtpPassword };
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: ssmParamName,
        Value: JSON.stringify(value),
        Type: 'SecureString',
        KeyId: kmsKeyId,
        Overwrite: true,
      })
    );
  } catch (err) {
    // Cleanup transaccional: la key no llegó a SSM → no debe quedar activa.
    await iam
      .send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId }))
      .catch(() => undefined);
    throw err;
  }

  return { userName, accessKeyId, smtpHost, ssmParamName, created: true };
}
