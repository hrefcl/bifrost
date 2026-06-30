import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { SSMClient } from '@aws-sdk/client-ssm';
import type { Route53Client } from '@aws-sdk/client-route-53';
import {
  ensureEmailIdentity,
  ensureMailFrom,
  setDefaultConfigurationSet,
  getEmailIdentityInfo,
  isProductionAccess,
  computeOutboundState,
  isOutboundReady,
  dkimCnameRecords,
  mailFromRecords,
  mailFromDomainFor,
  type DnsRecord,
  type OutboundState,
} from '../aws/ses-identity.js';
import { ensureConfigurationSet, ensureAccountSuppression } from '../aws/ses-reputation.js';
import { ensureSmtpCredentials, buildSesSendPolicy } from '../aws/ses-credentials.js';
import { upsertRecords } from '../aws/route53.js';

/**
 * Orquestador top-level del outbound SES turnkey — secuencia los módulos en el orden correcto y
 * devuelve el estado HONESTO + los records DNS (escritos si hay zona gestionada, o para que el operador
 * los agregue a mano si no). Ver docs/diseno-ses-turnkey.md. Idempotente de punta a punta: cada paso
 * reconcilia, así re-correr converge.
 *
 * NO cablea el relay: eso lo hace el box sólo cuando el estado es `ready` (send-gating §7b). Este
 * orquestador deja la infra lista y reporta en qué estado quedó.
 */
export interface OrchestrateSesInput {
  ses: SESv2Client;
  iam: IAMClient;
  ssm: SSMClient;
  r53: Route53Client;
  domain: string;
  region: string;
  accountId: string;
  /** Si se da, se escriben los records DKIM/MAIL FROM en esa zona. Si no, se devuelven para hacerlo a mano. */
  hostedZoneId?: string;
  ssmParamName: string;
  kmsKeyId?: string;
  configurationSetName: string;
  userName: string;
  policyName: string;
  tags?: { Key: string; Value: string }[];
}

export interface OrchestrateSesResult {
  state: OutboundState;
  /** Records DKIM (3 CNAME) + MAIL FROM (MX/TXT) que SES necesita en el DNS. */
  dnsRecords: DnsRecord[];
  /** true si se escribieron en Route53; false si el operador debe agregarlos manualmente. */
  dnsManaged: boolean;
  /**
   * true si se publicó la credencial SMTP en SSM (sólo cuando el outbound quedó `ready`). El box
   * detecta la EXISTENCIA del parámetro para activar el relay (send-gating §7b): en estados `pending-*`
   * NO se crea credencial, así el relay nunca se cablea antes de que DKIM/MAIL FROM verifiquen.
   */
  credentialPublished: boolean;
  accessKeyId?: string;
  ssmParamName: string;
  mailFromDomain: string;
}

export async function orchestrateSesOutbound(
  input: OrchestrateSesInput
): Promise<OrchestrateSesResult> {
  const { ses, iam, ssm, r53, domain, region, accountId } = input;

  // 1. Configuration set (métricas de reputación + supresión) ANTES de fijarlo como default de identidad.
  await ensureConfigurationSet(ses, input.configurationSetName);
  // 2. Suppression list a nivel cuenta (merge, no overwrite).
  await ensureAccountSuppression(ses);

  // 3. Identidad + Easy DKIM (idempotente) → tokens para los CNAME.
  const identity = await ensureEmailIdentity(ses, domain);
  // 4. Custom MAIL FROM en bounce.<dominio>.
  const mailFromDomain = mailFromDomainFor(domain);
  await ensureMailFrom(ses, domain, mailFromDomain);
  // 5. Config set como default de la identidad → SES lo aplica a TODO envío (sin header). [B4]
  await setDefaultConfigurationSet(ses, domain, input.configurationSetName);

  // 6. Records DNS que SES exige.
  const dnsRecords: DnsRecord[] = [
    ...dkimCnameRecords(domain, identity.dkimTokens),
    ...mailFromRecords(region, mailFromDomain),
  ];

  // 7. Escribirlos si gestionamos la zona; si no, se devuelven para hacerlo a mano.
  let dnsManaged = false;
  if (input.hostedZoneId) {
    await upsertRecords(r53, input.hostedZoneId, dnsRecords);
    dnsManaged = true;
  }

  // 8. Estado HONESTO: re-leer identidad (DKIM/MAIL FROM) + sandbox. Nunca `ready` antes de tiempo.
  const info = await getEmailIdentityInfo(ses, domain);
  const productionAccessEnabled = await isProductionAccess(ses);
  const state = computeOutboundState({
    dkimStatus: info.dkimStatus,
    mailFromStatus: info.mailFromStatus,
    productionAccessEnabled,
  });

  // 9. SEND-GATING (§7b): las credenciales SMTP se crean y publican en SSM SÓLO cuando el outbound está
  // `ready`. La EXISTENCIA del parámetro es la señal que el box usa para activar el relay → en estados
  // `pending-*` no hay credencial y el relay queda apagado. ses-activate re-corre esto al verificar.
  let accessKeyId: string | undefined;
  let credentialPublished = false;
  if (isOutboundReady(state)) {
    const creds = await ensureSmtpCredentials({
      iam,
      ssm,
      region,
      userName: input.userName,
      policyName: input.policyName,
      policyDocument: buildSesSendPolicy(region, accountId, domain),
      ssmParamName: input.ssmParamName,
      kmsKeyId: input.kmsKeyId,
      tags: input.tags,
    });
    accessKeyId = creds.accessKeyId;
    credentialPublished = true;
  }

  return {
    state,
    dnsRecords,
    dnsManaged,
    credentialPublished,
    accessKeyId,
    ssmParamName: input.ssmParamName,
    mailFromDomain,
  };
}
