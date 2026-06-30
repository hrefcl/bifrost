import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  PutEmailIdentityConfigurationSetAttributesCommand,
  GetAccountCommand,
} from '@aws-sdk/client-sesv2';

/**
 * Orquestación de la IDENTIDAD SES del dominio: Easy DKIM, Custom MAIL FROM y la máquina de estados
 * del outbound. Ver docs/diseno-ses-turnkey.md §1/§5. Todo lo posible es PURO (testeable sin AWS); los
 * wrappers de SDK son idempotentes.
 *
 * Honestidad (B-HIGH#3): el estado NUNCA es `ready` salvo que DKIM esté verificado, el MAIL FROM en
 * `success` y la cuenta fuera de sandbox. El relay se cablea sólo en `ready` (send-gating, §7b).
 */

/** Estados del outbound. El orden refleja el progreso; `failed-*` son terminales hasta corregir DNS. */
export type OutboundState =
  | 'pending-dkim'
  | 'failed-dkim'
  | 'pending-mail-from'
  | 'failed-mail-from'
  | 'pending-production-access'
  | 'ready';

export interface DnsRecord {
  name: string;
  type: 'CNAME' | 'MX' | 'TXT';
  value: string;
  ttl: number;
}

/** Subdominio Custom MAIL FROM. `bounce.` (NO `mail.`, reservado para MX/host operativo). [B-MED] */
export function mailFromDomainFor(domain: string): string {
  return `bounce.${domain}`;
}

/** Los 3 CNAME del Easy DKIM de SES a partir de los tokens. PURA. */
export function dkimCnameRecords(domain: string, tokens: readonly string[]): DnsRecord[] {
  return tokens.map((t) => ({
    name: `${t}._domainkey.${domain}`,
    type: 'CNAME',
    value: `${t}.dkim.amazonses.com`,
    ttl: 1800,
  }));
}

/** Los records del Custom MAIL FROM (MX al feedback de SES + SPF en el SUBDOMINIO, no en el apex). PURA. */
export function mailFromRecords(region: string, mailFromDomain: string): DnsRecord[] {
  return [
    {
      name: mailFromDomain,
      type: 'MX',
      value: `10 feedback-smtp.${region}.amazonses.com`,
      ttl: 1800,
    },
    {
      name: mailFromDomain,
      type: 'TXT',
      // SPF en el subdominio: `-all` es seguro acá (no rompe el SPF del apex existente). [B-HIGH#2]
      value: '"v=spf1 include:amazonses.com -all"',
      ttl: 1800,
    },
  ];
}

export interface OutboundStatusInput {
  /** DkimAttributes.Status de GetEmailIdentity. */
  dkimStatus?: string;
  /** MailFromAttributes.MailFromDomainStatus de GetEmailIdentity. */
  mailFromStatus?: string;
  /** GetAccount.ProductionAccessEnabled (false = sandbox). */
  productionAccessEnabled?: boolean;
}

/**
 * Máquina de estados PURA — la lógica honestidad-crítica. Cortocircuita en el primer gate no cumplido,
 * así nunca reporta `ready` antes de tiempo. SES usa SUCCESS/PENDING/FAILED/TEMPORARY_FAILURE/NOT_STARTED.
 */
export function computeOutboundState(input: OutboundStatusInput): OutboundState {
  const dkim = (input.dkimStatus ?? 'PENDING').toUpperCase();
  if (dkim === 'FAILED') return 'failed-dkim';
  if (dkim !== 'SUCCESS') return 'pending-dkim';

  const mf = (input.mailFromStatus ?? 'PENDING').toUpperCase();
  if (mf === 'FAILED') return 'failed-mail-from';
  if (mf !== 'SUCCESS') return 'pending-mail-from';

  // DKIM + MAIL FROM ok; sólo falta salir del sandbox (paso manual de AWS, no automatizable).
  if (input.productionAccessEnabled !== true) return 'pending-production-access';

  return 'ready';
}

/** El relay sólo se cablea cuando el outbound está `ready` (send-gating §7b). */
export function isOutboundReady(state: OutboundState): boolean {
  return state === 'ready';
}

export interface EmailIdentityInfo {
  dkimTokens: string[];
  dkimStatus: string;
  mailFromDomain?: string;
  mailFromStatus?: string;
}

/**
 * Crea la identidad del dominio con Easy DKIM (2048-bit) si no existe; idempotente. Devuelve los tokens
 * DKIM (para los CNAME) y el estado actual.
 */
export async function ensureEmailIdentity(
  ses: SESv2Client,
  domain: string
): Promise<EmailIdentityInfo> {
  try {
    await ses.send(
      new CreateEmailIdentityCommand({
        EmailIdentity: domain,
        DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
      })
    );
  } catch (err) {
    // Ya existe → seguimos a leer su estado. Cualquier otro error se propaga.
    if ((err as { name?: string }).name !== 'AlreadyExistsException') throw err;
  }
  return getEmailIdentityInfo(ses, domain);
}

export async function getEmailIdentityInfo(
  ses: SESv2Client,
  domain: string
): Promise<EmailIdentityInfo> {
  const res = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
  return {
    dkimTokens: res.DkimAttributes?.Tokens ?? [],
    dkimStatus: res.DkimAttributes?.Status ?? 'NOT_STARTED',
    mailFromDomain: res.MailFromAttributes?.MailFromDomain,
    mailFromStatus: res.MailFromAttributes?.MailFromDomainStatus,
  };
}

/** Configura el Custom MAIL FROM en `bounce.<dominio>`; idempotente. `USE_DEFAULT_VALUE` evita rebotes */
/** mientras el MX del subdominio propaga (cae al MAIL FROM por defecto en vez de fallar). [B/D] */
export async function ensureMailFrom(
  ses: SESv2Client,
  domain: string,
  mailFromDomain = mailFromDomainFor(domain)
): Promise<void> {
  await ses.send(
    new PutEmailIdentityMailFromAttributesCommand({
      EmailIdentity: domain,
      MailFromDomain: mailFromDomain,
      BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
    })
  );
}

/**
 * Fija el configuration set como DEFAULT de la identidad → SES lo aplica a TODO envío sin depender de
 * un header (cierra el bug de bypass por correo sin Subject). [B4] Ver §6.
 */
export async function setDefaultConfigurationSet(
  ses: SESv2Client,
  domain: string,
  configurationSetName: string
): Promise<void> {
  await ses.send(
    new PutEmailIdentityConfigurationSetAttributesCommand({
      EmailIdentity: domain,
      ConfigurationSetName: configurationSetName,
    })
  );
}

/** ¿La cuenta SES salió del sandbox? (false = sandbox: sólo manda a destinos verificados). */
export async function isProductionAccess(ses: SESv2Client): Promise<boolean> {
  const res = await ses.send(new GetAccountCommand({}));
  return res.ProductionAccessEnabled === true;
}
