import { SESv2Client } from '@aws-sdk/client-sesv2';
import { IAMClient } from '@aws-sdk/client-iam';
import { SSMClient } from '@aws-sdk/client-ssm';
import { Route53Client } from '@aws-sdk/client-route-53';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { orchestrateSesOutbound } from './orchestrate.js';
import {
  getEmailIdentityInfo,
  isProductionAccess,
  computeOutboundState,
  type OutboundState,
} from '../aws/ses-identity.js';
import { listSuppressed, setSendingEnabled } from '../aws/ses-reputation.js';
import { sesParamName, sesUserName, sesConfigSetName, SES_POLICY_NAME } from './naming.js';

/** Subcomandos SES del CLI (lo que el operador puede correr post-provision). */
export const SES_COMMANDS = [
  'ses-status',
  'ses-activate',
  'ses-suppressions',
  'ses-pause',
  'ses-resume',
] as const;
export type SesCommand = (typeof SES_COMMANDS)[number];

/** Resuelve el subcomando desde argv[2]. PURO (testeable). null si no es un comando SES. */
export function resolveSesCommand(argv: readonly string[]): SesCommand | null {
  const cmd = argv[2] as string | undefined;
  return cmd && (SES_COMMANDS as readonly string[]).includes(cmd) ? (cmd as SesCommand) : null;
}

/** Mensaje humano por estado (honesto: explica qué falta y qué hacer). */
export function explainState(state: OutboundState): string {
  switch (state) {
    case 'pending-dkim':
      return 'DKIM sin verificar — esperá la propagación de los CNAME (hasta 72h) y reintentá ses-status.';
    case 'failed-dkim':
      return 'DKIM FALLÓ — revisá que los 3 CNAME estén bien cargados en el DNS.';
    case 'pending-mail-from':
      return 'Custom MAIL FROM sin verificar — falta propagar el MX/TXT de bounce.<dominio>.';
    case 'failed-mail-from':
      return 'MAIL FROM FALLÓ — revisá el MX/TXT del subdominio bounce.';
    case 'pending-production-access':
      return 'DKIM+MAIL FROM OK pero la cuenta SES está en SANDBOX (sólo destinos verificados, 200/día). Pedí acceso a producción en la consola de SES y reintentá ses-activate.';
    case 'ready':
      return 'Outbound LISTO — credencial publicada; el box activa el relay en ≤5 min.';
  }
}

interface SesClients {
  ses: SESv2Client;
  iam: IAMClient;
  ssm: SSMClient;
  r53: Route53Client;
  sts: STSClient;
}

function makeSesClients(region: string): SesClients {
  return {
    ses: new SESv2Client({ region }),
    iam: new IAMClient({ region }),
    ssm: new SSMClient({ region }),
    r53: new Route53Client({ region }),
    sts: new STSClient({ region }),
  };
}

async function accountId(sts: STSClient): Promise<string> {
  const res = await sts.send(new GetCallerIdentityCommand({}));
  if (!res.Account) throw new Error('No se pudo resolver el AccountId (STS)');
  return res.Account;
}

/** ses-status: lee el estado del outbound y lo explica (read-only, no toca nada). */
export async function runSesStatus(domain: string, region: string): Promise<OutboundState> {
  const { ses } = makeSesClients(region);
  const info = await getEmailIdentityInfo(ses, domain);
  const prod = await isProductionAccess(ses);
  const state = computeOutboundState({
    dkimStatus: info.dkimStatus,
    mailFromStatus: info.mailFromStatus,
    productionAccessEnabled: prod,
  });
  console.log(`Outbound SES para ${domain}: ${state}`);
  console.log(
    `  DKIM=${info.dkimStatus}  MAIL FROM=${info.mailFromStatus ?? 'no-configurado'}  sandbox=${prod ? 'no' : 'sí'}`
  );
  console.log(`  → ${explainState(state)}`);
  return state;
}

/** ses-activate: corre el orquestador (idempotente) — verifica estado y, si quedó `ready`, publica la credencial. */
export async function runSesActivate(
  domain: string,
  region: string,
  opts: { hostedZoneId?: string; kmsKeyId?: string } = {}
): Promise<void> {
  const c = makeSesClients(region);
  const res = await orchestrateSesOutbound({
    ses: c.ses,
    iam: c.iam,
    ssm: c.ssm,
    r53: c.r53,
    domain,
    region,
    accountId: await accountId(c.sts),
    hostedZoneId: opts.hostedZoneId,
    ssmParamName: sesParamName(domain),
    kmsKeyId: opts.kmsKeyId,
    configurationSetName: sesConfigSetName(domain),
    userName: sesUserName(domain),
    policyName: SES_POLICY_NAME,
    tags: [{ Key: 'bifrost:managed', Value: 'ses' }],
  });
  console.log(`Outbound SES: ${res.state}`);
  console.log(`  → ${explainState(res.state)}`);
  if (!res.dnsManaged) {
    console.log('\n  Cargá estos registros en tu DNS (no se gestionó la zona automáticamente):');
    for (const r of res.dnsRecords) console.log(`    ${r.type}  ${r.name}  →  ${r.value}`);
  }
  if (res.credentialPublished) {
    console.log('\n  ✅ Credencial publicada en SSM; el box activa el relay en ≤5 min.');
  }
}

/** ses-suppressions: lista las addresses suprimidas (bounces/complaints) — visibilidad para el operador. */
export async function runSesSuppressions(region: string): Promise<void> {
  const { ses } = makeSesClients(region);
  const list = await listSuppressed(ses);
  if (list.length === 0) {
    console.log('Sin direcciones suprimidas.');
    return;
  }
  console.log(`${String(list.length)} direcciones suprimidas (no se les envía):`);
  for (const e of list) console.log(`  ${e.email}  (${e.reason})`);
}

/** ses-pause / ses-resume: corta o reanuda el envío del configuration set (override del auto-pause). */
export async function runSesSending(
  domain: string,
  region: string,
  enabled: boolean
): Promise<void> {
  const { ses } = makeSesClients(region);
  await setSendingEnabled(ses, sesConfigSetName(domain), enabled);
  console.log(`Envío del set ${sesConfigSetName(domain)}: ${enabled ? 'REANUDADO' : 'PAUSADO'}.`);
}
