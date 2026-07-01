#!/usr/bin/env node
import { input, confirm, select, number, password } from '@inquirer/prompts';
import { writeFileSync } from 'node:fs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { Route53Client } from '@aws-sdk/client-route-53';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { listVpcs, listSubnets } from './aws/vpc.js';
import { listPublicHostedZones, matchHostedZone } from './aws/route53.js';
import { ensureKeyPair } from './aws/compute.js';
import { buildUserData } from './mailserver/user-data.js';
import { buildStackTemplate, templateToYaml, templateToJson } from './infra/stack-template.js';
import { assembleStackParams, deriveBucketName, type WizardAnswers } from './wizard/params.js';
import {
  deployStack,
  getStackStatus,
  getStackOutputs,
  stackExists,
  deleteStack,
  waitForStackDeleted,
} from './aws/cloudformation.js';
import { emptyBucket } from './aws/s3.js';
import { estimateMonthlyCost } from './cost.js';
import {
  ALLINONE_CATALOG,
  recommendInstanceFor,
  describeInstanceChoice,
  enforceMeetInstanceFloor,
  type InstanceTypeInfo,
} from './catalog/instance-types.js';
import { mailHostname, validateDomain } from './domain.js';
import {
  resolveSesCommand,
  runSesStatus,
  runSesActivate,
  runSesSuppressions,
  runSesSending,
} from './ses/commands.js';
import { sesParamName } from './ses/naming.js';
import { livekitSecretParamName, validateExternalLivekitWsUrl } from './meet/livekit-external.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const slug = (s: string): string => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const orUndef = (s: string): string | undefined => (s === '' ? undefined : s);

/** Lee el valor de un flag `--k=v` o `--k v` de argv (no-interactivo). undefined si no está. */
function argFlagValue(flag: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

function printDns(domain: string, ip: string, enableMeet = false): void {
  const host = mailHostname(domain);
  console.log('\nCargá estos registros DNS (en tu zona del dominio):');
  console.log(`  A     ${host}        → ${ip}`);
  console.log(`  A     webmail.${domain} → ${ip}  (la UI web / TLS)`);
  console.log(`  MX    ${domain}      → ${host} (prioridad 10)`);
  console.log(`  TXT   ${domain}      → "v=spf1 mx ~all"`);
  console.log(`  TXT   _dmarc.${domain} → "v=DMARC1; p=quarantine"`);
  if (enableMeet) {
    console.log(`  A     meet.${domain}    → ${ip}  (Bifrost Meet / LiveKit)`);
    console.log(`  A     turn.meet.${domain} → ${ip}  (TURN/STUN de Meet)`);
  }
  console.log('  (El DKIM se genera en el servidor; lo agregás después.)');
}

function printInstructions(file: string, stackName: string, region: string): void {
  console.log('\nPara crearlo vos mismo:');
  console.log('  • AWS CLI:');
  console.log(
    `      aws cloudformation deploy --region ${region} --stack-name ${stackName} \\\n        --template-file ${file} --capabilities CAPABILITY_NAMED_IAM`
  );
  console.log('  • Consola web: CloudFormation → Create stack → "Upload a template file" → elegí');
  console.log(`      ${file} → Next → completá los parámetros → Create.`);
  console.log(
    '  • Teardown: `bifrost-provision destroy` (vacía el bucket y borra TODO el stack), o CloudFormation → Delete.'
  );
}

async function main(): Promise<void> {
  console.log('Bifrost — wizard de instalación (genera un CloudFormation y lo corre)\n');

  const domain = await input({ message: 'Dominio de correo (ej. empresa.com)' });
  if (!validateDomain(domain)) {
    console.error(`Dominio inválido (FQDN): ${domain}`);
    process.exit(1);
  }
  const region = await input({ message: 'Región AWS', default: 'us-east-1' });
  const stackName = `bifrost-${slug(domain)}`;
  // Buzones/empleados PRIMERO: dimensiona la instancia recomendada (más abajo, tras elegir Meet).
  // Flag --mailboxes para automatización (el reorden movió este prompt → un expect por orden se rompía). [B4]
  const mailboxesFlag = argFlagValue('--mailboxes');
  let mailboxes: number;
  if (mailboxesFlag !== undefined) {
    // Estricto: sólo dígitos (parseInt aceptaría "1.5"→1 o "10abc"→10 en silencio). [review B5]
    if (!/^\d+$/.test(mailboxesFlag.trim()) || Number.parseInt(mailboxesFlag, 10) < 1) {
      console.error(`--mailboxes inválido: "${mailboxesFlag}" (debe ser un entero ≥1).`);
      process.exit(1);
    }
    mailboxes = Number.parseInt(mailboxesFlag, 10);
  } else {
    mailboxes = (await number({ message: '¿Cuántos buzones/empleados?', default: 50 })) ?? 50;
  }
  // Bifrost Meet (videollamadas LiveKit): 3 modos. OFF (default) | BUNDLED (LiveKit en ESTE EC2: 2º SG,
  // ≥8 GiB RAM, ~+$25/mes) | EXTERNAL (apuntar a un LiveKit que ya tenés, p.ej. Cleverty: sin infra de
  // media local, sólo firma tokens). No-interactivo: --meet-mode off|bundled|external, o los alias
  // --enable-meet (=bundled) y --meet-external-url ... (=external). Default OFF.
  const meetModeFlag = argFlagValue('--meet-mode');
  let meetMode: 'off' | 'bundled' | 'external';
  if (meetModeFlag === 'off' || meetModeFlag === 'bundled' || meetModeFlag === 'external') {
    meetMode = meetModeFlag;
  } else if (process.argv.includes('--enable-meet')) {
    meetMode = 'bundled';
  } else if (argFlagValue('--meet-external-url') !== undefined) {
    meetMode = 'external';
  } else {
    meetMode = await select({
      message: 'Bifrost Meet (videollamadas)',
      choices: [
        { name: 'No, sin videollamadas', value: 'off' as const },
        {
          name: 'Sí — LiveKit self-hosted en ESTE EC2 (abre puertos media, exige ≥8 GiB RAM, ~+$25/mes)',
          value: 'bundled' as const,
        },
        {
          name: 'Sí — apuntar a un LiveKit EXTERNO que ya tengo (URL WSS + key + secret; sin infra local)',
          value: 'external' as const,
        },
      ],
      default: 'off',
    });
  }
  const enableMeet = meetMode === 'bundled';
  if (enableMeet) {
    console.log(
      '⚠ Meet self-hosted corre LiveKit en ESTE EC2: exige ≥8 GiB de RAM y sube el costo (instancia más grande + puertos media). Si vas a tener muchas llamadas, considerá el modo EXTERNAL.'
    );
  }

  // Modo EXTERNAL: colectar URL WSS + key + secret del LiveKit ya existente. El secret NO viaja en
  // user-data/CFN: se guarda en SSM SecureString (más abajo) y el box lo lee con el rol. Fail-closed:
  // validamos wss:// y exigimos key/secret no vacíos ANTES de tocar nada. [review B/D]
  let meetExternal:
    | { wsUrl: string; apiUrl: string; apiKey: string; apiSecret: string; secretParamName: string }
    | undefined;
  if (meetMode === 'external') {
    const wsUrlRaw =
      argFlagValue('--meet-external-url') ??
      (await input({ message: 'URL WSS del LiveKit externo (wss://livekit.tudominio…)' }));
    const v = validateExternalLivekitWsUrl(wsUrlRaw);
    if (!v.ok) {
      console.error(`URL de LiveKit externo inválida: ${v.error}`);
      process.exit(1);
    }
    const apiKey = (
      argFlagValue('--meet-external-key') ??
      (await input({ message: 'API Key del LiveKit externo' }))
    ).trim();
    // Secret: preferir la env var BIFROST_LIVEKIT_SECRET (no queda en el history del shell ni en `ps`),
    // luego el flag (con aviso), luego el prompt oculto. [review B-LOW]
    const secretFromEnv = process.env.BIFROST_LIVEKIT_SECRET;
    const secretFromFlag = argFlagValue('--meet-external-secret');
    if (secretFromFlag && !secretFromEnv) {
      console.log(
        '⚠ --meet-external-secret queda en el history del shell y en `ps`. Preferí BIFROST_LIVEKIT_SECRET=… (env) o el prompt.'
      );
    }
    const apiSecret = (
      secretFromEnv ??
      secretFromFlag ??
      (await password({ message: 'API Secret del LiveKit externo', mask: true }))
    ).trim();
    if (!apiKey || !apiSecret) {
      console.error(
        'LiveKit externo: la API key y el API secret son obligatorios (no pueden ir vacíos).'
      );
      process.exit(1);
    }
    meetExternal = {
      wsUrl: v.wsUrl,
      apiUrl: v.apiUrl,
      apiKey,
      apiSecret,
      secretParamName: livekitSecretParamName(domain),
    };
    console.log(
      `✓ LiveKit externo: ${v.wsUrl} (API ${v.apiUrl}). El secret irá a SSM cifrado (no al user-data).`
    );
  }

  // Selección de instancia: menú CURADO con costo + capacidad (buzones, y participantes de Meet si es
  // bundled), recomendando la MÁS CHICA que cubre los buzones elegidos. Con Meet bundled sólo se ofrecen
  // las aptas (≥8 GiB). "Otro" permite un tipo a mano (se respeta; si es bundled se aplica el piso de RAM).
  // No-interactivo: --instance-type <tipo>.
  const recFor = recommendInstanceFor(mailboxes, enableMeet);
  if (recFor.exceedsCatalog) {
    console.log(
      `⚠ ${String(mailboxes)} buzones${enableMeet ? ' con Meet' : ''} superan el catálogo estándar; recomiendo la más grande (${recFor.instance.type}). Para más escala usá "Otro" (instancia mayor) o LiveKit externo.`
    );
  }
  const eligibleInstances = enableMeet
    ? ALLINONE_CATALOG.filter((i) => i.meetConcurrent > 0)
    : ALLINONE_CATALOG;
  const OTHER_INSTANCE = '__other__';
  const instanceFlag = argFlagValue('--instance-type');
  // Fail-closed: `--instance-type` presente pero SIN valor —  `--instance-type=`, `--instance-type ""`, o
  // el flag al final de argv sin nada después— es un error de automatización → abortar claro, no caer al
  // menú (que colgaría esperando input). [review D4/B5]
  if (
    process.argv.includes('--instance-type') &&
    (instanceFlag === undefined || instanceFlag.trim() === '')
  ) {
    console.error(
      '--instance-type está vacío; pasá un tipo EC2 válido (p.ej. --instance-type t4g.large).'
    );
    process.exit(1);
  }
  let instanceType: string;
  let instanceInfo: InstanceTypeInfo | undefined;
  if (instanceFlag !== undefined) {
    instanceType = instanceFlag.trim();
    instanceInfo = ALLINONE_CATALOG.find((i) => i.type === instanceType);
  } else {
    const picked = await select({
      message: `Tipo de EC2 (recomendado para ${String(mailboxes)} buzones${enableMeet ? ' + Meet' : ''}: ${recFor.instance.type})`,
      choices: [
        ...eligibleInstances.map((i) => ({
          name: describeInstanceChoice(i, enableMeet),
          value: i.type,
        })),
        {
          name: 'Otro (escribir el tipo a mano — p.ej. m7g.2xlarge para casos grandes)',
          value: OTHER_INSTANCE,
        },
      ],
      default: recFor.instance.type,
    });
    if (picked === OTHER_INSTANCE) {
      instanceType = (
        await input({
          message: 'Tipo EC2 exacto (arm64/Graviton lleva "g": t4g/m7g/c7g; x86: t3/m7i…)',
          default: recFor.instance.type,
        })
      ).trim();
    } else {
      instanceType = picked;
    }
    instanceInfo = ALLINONE_CATALOG.find((i) => i.type === instanceType);
  }
  // Piso de RAM para Meet bundled: sólo puede faltar por la vía "Otro"/flag fuera de catálogo (el menú ya
  // filtra a ≥8 GiB). Sube al piso si el tipo de catálogo es chico; avisa si es un tipo desconocido.
  if (enableMeet) {
    const floor = enforceMeetInstanceFloor(instanceType);
    if (floor.bumped) {
      console.log(`⚠ Meet self-hosted exige ≥8 GiB; subo ${instanceType} → ${floor.type}.`);
      instanceType = floor.type;
      instanceInfo = ALLINONE_CATALOG.find((i) => i.type === instanceType);
    } else if (floor.unknownBelowFloor) {
      // Instancia fuera de catálogo + Meet bundled: no podemos verificar los ≥8 GiB. NO seguir en silencio
      // (un t4g.small con LiveKit hace OOM). Requiere confirmación explícita: --allow-unknown-meet-instance
      // (no-interactivo) o un confirm (interactivo, vía "Otro"). Si no, abortar claro. [review B4-MED]
      const allowUnknown = process.argv.includes('--allow-unknown-meet-instance');
      let proceed = allowUnknown;
      if (!proceed && instanceFlag === undefined) {
        proceed = await confirm({
          message: `"${instanceType}" no está en el catálogo; no puedo verificar que tenga ≥8 GiB (Meet self-hosted los exige; una instancia chica hace OOM). ¿Continuar igual?`,
          default: false,
        });
      }
      if (!proceed) {
        console.error(
          `Abortado: "${instanceType}" no es verificable para Meet self-hosted. Elegí una de catálogo (≥8 GiB), pasá --allow-unknown-meet-instance si estás seguro, o usá LiveKit externo.`
        );
        process.exit(1);
      }
      console.log(
        `⚠ Sigo con "${instanceType}" (fuera de catálogo); asegurate de que tenga ≥8 GiB para Meet.`
      );
    }
  }
  const instanceMonthlyUsd = instanceInfo?.approxMonthlyUsd ?? recFor.instance.approxMonthlyUsd;

  const useS3 = await confirm({
    message:
      '¿Guardar los adjuntos en S3 cifrado? (la palanca de costo: bucket+KMS, la app lo usa vía el rol del EC2; recursos facturables)',
    default: true,
  });
  const enableSes = await confirm({
    message:
      '¿Habilitar envío saliente vía Amazon SES? (AWS bloquea el puerto 25; SES es el relay. Se cablea turnkey, pero la verificación DKIM y salir del sandbox no son instantáneas — el box reporta el estado)',
    default: true,
  });
  const sshCidr = await input({
    message: 'CIDR permitido para SSH (recomendado TU_IP/32; Enter = 0.0.0.0/0 ABIERTO a internet)',
    default: '0.0.0.0/0',
  });
  if (sshCidr === '0.0.0.0/0') {
    console.log('⚠ SSH quedará ABIERTO a internet (0.0.0.0/0). Considerá restringir a tu IP/32.');
  }

  // Cuenta admin turnkey: se crea el buzón en docker-mailserver y al primer login queda admin (bootstrap).
  const adminMailbox = await input({
    message: 'Email del usuario ADMIN (se crea el buzón)',
    default: `admin@${domain}`,
  });
  const adminMailboxPassword = await password({
    message: 'Clave del admin (mínimo 8 caracteres)',
    mask: true,
    validate: (v) => v.length >= 8 || 'Mínimo 8 caracteres',
  });

  const connect = await confirm({
    message:
      '¿Conectar a AWS ahora para revisar tu cuenta? (si NO, genero el YAML para que lo corras vos)',
    default: false,
  });

  let existingVpcId = '';
  let existingSubnetId = '';
  let keyName = '';
  let pem: string | null = null;
  let hostedZoneId = '';

  if (connect) {
    const ec2 = new EC2Client({ region });
    const vpcs = await listVpcs(ec2);
    if (vpcs.length > 0) {
      existingVpcId = await select({
        message: '¿En qué VPC instalo el EC2?',
        choices: [
          { name: 'Crear una VPC nueva (recomendado)', value: '' },
          ...vpcs.map((v) => ({
            name: `${v.id}${v.isDefault ? ' (default)' : ''} — ${v.cidr}`,
            value: v.id,
          })),
        ],
      });
      if (existingVpcId !== '') {
        const subs = (await listSubnets(ec2, existingVpcId)).filter((s) => s.mapPublicIp);
        if (subs.length === 0) {
          console.log('⚠ Esa VPC no tiene subnets PÚBLICAS; el correo no sería alcanzable.');
          console.log('  Volvé a correr y elegí "Crear una VPC nueva".');
          return;
        }
        existingSubnetId = await select({
          message: 'Subnet pública donde lanzar',
          choices: subs.map((s) => ({ name: `${s.id} — ${s.az} — ${s.cidr}`, value: s.id })),
        });
      }
    }
    keyName = await input({
      message: 'Nombre para el key pair SSH',
      default: `bifrost-${slug(domain)}`,
    });
    const kp = await ensureKeyPair(ec2, { name: keyName, domain });
    pem = kp.privateKeyPem;

    // DNS: si detecto una zona Route53 del dominio, ofrezco gestionar los registros desde el stack.
    const zones = await listPublicHostedZones(new Route53Client({ region }));
    const m = matchHostedZone(zones, domain);
    const zone = m.exact ?? m.parent;
    if (zone) {
      const manage = await confirm({
        message: `Detecté la zona Route53 ${zone.name} (${zone.id}). ¿Creo los registros DNS (A/MX/SPF/DMARC) desde el stack? OJO: si tu zona YA tiene MX/TXT en el dominio puede chocar.`,
        default: false,
      });
      if (manage) hostedZoneId = zone.id;
    }
  } else {
    keyName = await input({
      message:
        'Nombre de un key pair SSH EXISTENTE en tu cuenta (creá uno en la consola si no tenés)',
    });
    const hz = await input({
      message:
        'Hosted zone Route53 para gestionar el DNS desde el stack — pegá su Id (Enter para omitir y cargar el DNS a mano)',
      default: '',
    });
    hostedZoneId = hz.trim();
  }

  // Armar user-data + parámetros + template, y escribir el YAML (el entregable). Si se eligió S3, el
  // user-data cablea el .env a storage=s3 con el bucket (mismo nombre que recibe el CFN) + rol del EC2.
  const s3Bucket = useS3 ? deriveBucketName(domain) : undefined;
  const userData = buildUserData({
    domain,
    mailHostname: mailHostname(domain),
    adminEmail: `admin@${domain}`,
    stackName,
    region,
    s3Bucket,
    adminMailbox,
    adminMailboxPassword,
    enableMeet,
    // Meet externo → el box lee el apiSecret de SSM y cablea LIVEKIT_* al .env (sin container local).
    meetExternal: meetExternal
      ? {
          wsUrl: meetExternal.wsUrl,
          apiUrl: meetExternal.apiUrl,
          apiKey: meetExternal.apiKey,
          secretParamName: meetExternal.secretParamName,
        }
      : undefined,
    // SES on → el box instala el helper que lee la credencial SMTP de ESTE parámetro SSM.
    sesParamName: enableSes ? sesParamName(domain) : undefined,
  });
  const answers: WizardAnswers = {
    domain,
    instanceType,
    keyName,
    userData,
    useS3,
    existingVpcId: orUndef(existingVpcId),
    existingSubnetId: orUndef(existingSubnetId),
    hostedZoneId: orUndef(hostedZoneId),
    sshCidr,
    enableMeet,
    meetExternal: meetExternal ? { secretParamName: meetExternal.secretParamName } : undefined,
    enableSes,
  };
  const params = assembleStackParams(answers);
  const file = `bifrost-stack-${slug(domain)}.yaml`;
  writeFileSync(file, templateToYaml(buildStackTemplate(userData)));
  console.log(`\n✓ CloudFormation escrito en ./${file}`);
  if (pem !== null) {
    const pemFile = `${keyName}.pem`;
    writeFileSync(pemFile, pem, { mode: 0o600 });
    console.log(`✓ Clave SSH privada en ./${pemFile} (0600) — guardala bien.`);
  }

  const cost = estimateMonthlyCost({
    instanceMonthlyUsd,
    ebsGiB: useS3 ? 40 : 240,
    s3GiB: useS3 ? 200 : 0,
    dataTransferOutGiB: 50,
    mailboxes,
    createHostedZone: false,
    useKms: useS3,
  });
  console.log(
    `\nCosto estimado ~$${String(cost.total)}/mes → ~$${String(cost.perMailbox)}/buzón ` +
      `(comercial a $7: ~$${String(mailboxes * 7)}/mes)`
  );
  if (instanceInfo === undefined) {
    console.log(
      `  (Nota: "${instanceType}" está fuera del catálogo → el costo del EC2 es una REFERENCIA (${describeInstanceChoice(recFor.instance, enableMeet).split(' — ')[0]}); tu tipo puede costar distinto.)`
    );
  }

  if (connect) {
    const run = await confirm({
      message: '¿Corro el stack AHORA? (crea recursos REALES y factura)',
      default: false,
    });
    if (run) {
      // Meet externo: publicar el apiSecret en SSM SecureString JUSTO antes del deploy (así existe cuando
      // el user-data lo lea, y NO se toca SSM si el operador decide no correr — evita rotar un secret sin
      // desplegar). [review B-MED] El SecureString cifra el valor con KMS; el rol del box lo descifra.
      if (meetExternal) {
        await new SSMClient({ region }).send(
          new PutParameterCommand({
            Name: meetExternal.secretParamName,
            Value: meetExternal.apiSecret,
            Type: 'SecureString',
            Overwrite: true,
          })
        );
        console.log(
          `✓ Secret del LiveKit externo guardado en SSM SecureString: ${meetExternal.secretParamName}`
        );
      }
      const cfn = new CloudFormationClient({ region });
      const action = await deployStack(cfn, {
        stackName,
        // EMBEBER el userData (igual que el YAML entregable): sin él, el template conserva el parámetro
        // requerido `UserData` que `params` ya no incluye → CFN falla; y con Meet el `Fn::Join`/EIP nunca
        // se aplicaría (la inyección sólo ocurre al embeber). [B-HIGH F3.5]
        templateBody: templateToJson(buildStackTemplate(userData)),
        params,
      });
      console.log(`\nStack ${action}: ${stackName}. Esperando (puede tardar ~10–15 min)…`);
      // Polling con TIMEOUT (no colgar para siempre) y aviso de ROLLBACK.
      const deadline = Date.now() + 30 * 60 * 1000; // 30 min
      let status = (await getStackStatus(cfn, stackName)) ?? 'UNKNOWN';
      let rollbackWarned = false;
      while (status.endsWith('IN_PROGRESS') && Date.now() < deadline) {
        if (status.includes('ROLLBACK') && !rollbackWarned) {
          console.log('  ⚠ ROLLBACK en curso — algo falló; CloudFormation está revirtiendo.');
          rollbackWarned = true;
        }
        await sleep(10_000);
        status = (await getStackStatus(cfn, stackName)) ?? 'UNKNOWN';
        console.log(`  estado: ${status}`);
      }
      if (status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE') {
        const out = await getStackOutputs(cfn, stackName);
        console.log(`\n✓ Listo. IP pública: ${out.PublicIp ?? '(ver en la consola)'}`);
        if (hostedZoneId !== '') {
          console.log(
            `  Los registros DNS (A/MX/webmail/SPF/DMARC${enableMeet ? '/meet/turn.meet' : ''}) se crearon en tu zona Route53.`
          );
          console.log('  (El DKIM se genera en el servidor; lo agregás después.)');
        } else {
          printDns(domain, out.PublicIp ?? 'TU_IP', enableMeet);
        }
        if (enableMeet) {
          console.log(
            `\n📹 Bifrost Meet ACTIVO → ${out.MeetUrl ?? `https://meet.${domain}`} (apuntá meet. y turn.meet. a la IP).`
          );
        }
        if (meetExternal) {
          console.log(
            `\n📹 Bifrost Meet ACTIVO contra LiveKit EXTERNO → ${meetExternal.wsUrl} (sin infra de media local; el box sólo firma tokens).`
          );
        }
        if (enableSes) {
          console.log('\n📨 ENVÍO SALIENTE (Amazon SES) — el box quedó cableado turnkey:');
          console.log(
            `   1) Activá/verificá la identidad SES corriendo:  bifrost-provision ses-activate`
          );
          console.log(
            '      (crea identidad+DKIM+MAIL FROM, escribe los CNAME en tu DNS si gestionás la zona,'
          );
          console.log(
            '       y configura supresión + métricas de reputación). Es idempotente: re-corré.'
          );
          console.log(
            '   2) Esperá la verificación DKIM (hasta 72h, normalmente minutos) — chequeá con: ses-status'
          );
          console.log(
            '   3) SANDBOX: una cuenta SES nueva sólo manda a destinos VERIFICADOS (200/día). Para enviar'
          );
          console.log(
            '      a cualquiera pedí "production access" en la consola de SES. ses-status te avisa el estado.'
          );
          console.log(
            '   → Cuando el outbound quede `ready`, el box activa el relay solo (≤5 min); no toca nada más.'
          );
        } else {
          console.log(
            '\n⚠ ENVÍO SALIENTE: AWS BLOQUEA el puerto 25 saliente. No habilitaste SES, así que el'
          );
          console.log(
            '  box RECIBE pero no ENVÍA a internet. Para enviar, re-provisioná con SES habilitado o'
          );
          console.log('  pedí a AWS el desbloqueo del puerto 25 (formulario de soporte).');
        }
      } else if (status.endsWith('IN_PROGRESS')) {
        console.log(`\n⏱ Timeout de espera; el stack sigue en ${status}. Seguí en la consola web.`);
      } else {
        console.log(`\n✗ El stack terminó en ${status}. Revisá los eventos en la consola web.`);
      }
      return;
    }
  }

  // No se corrió → instrucciones para que lo haga el usuario. Con LiveKit externo, el secret NO se subió a
  // SSM (sólo se sube al desplegar) → el operador debe crearlo a mano antes de lanzar, o el box fail-closed.
  if (meetExternal) {
    console.log(
      '\n⚠ LiveKit externo: ANTES de lanzar el stack, guardá el apiSecret en SSM SecureString:'
    );
    console.log(`   aws ssm put-parameter --type SecureString --overwrite --region ${region} \\`);
    console.log(`     --name '${meetExternal.secretParamName}' --value '<TU_API_SECRET>'`);
    console.log('   (Si el parámetro no existe al boot, el box FALLA-CLOSED y Meet no arranca.)');
  }
  printInstructions(file, stackName, region);
}

/**
 * Teardown: `bifrost-provision destroy [stackName]`. Borra TODA la infraestructura del stack (es UN
 * stack de CloudFormation → no hay huérfanos). Vacía el bucket S3 antes (CFN no borra un bucket no
 * vacío). Cierra el círculo provision↔destroy para poder probar desde cero.
 */
async function destroy(): Promise<void> {
  console.log('Bifrost — teardown: borra TODA la infraestructura de un stack\n');
  const argStack = process.argv.at(3); // string | undefined
  const region = await input({ message: 'Región AWS del stack', default: 'us-east-1' });
  const stackName =
    argStack ??
    `bifrost-${slug(await input({ message: 'Dominio del stack a borrar (ej: aulion.app)' }))}`;
  const cfn = new CloudFormationClient({ region });

  if (!(await stackExists(cfn, stackName))) {
    console.log(`No existe el stack "${stackName}" en ${region}. Nada que borrar.`);
    return;
  }
  const outputs = await getStackOutputs(cfn, stackName);
  const bucket = outputs.S3Bucket;
  // Salvaguarda anti-typo: los stacks de Bifrost se llaman `bifrost-<dominio>`. Si el nombre no sigue
  // la convención, avisar fuerte (no bloquear: alguien pudo usar un nombre custom) para no nukear otro.
  if (!stackName.startsWith('bifrost-')) {
    console.log(
      `\n⚠ "${stackName}" NO sigue la convención bifrost-<dominio>. Asegurate de que sea el stack correcto.`
    );
  }
  const ok = await confirm({
    message: `⚠ Esto BORRA TODO el stack "${stackName}" (EC2, EIP, SG, VPC, rol, DNS${
      bucket ? `, el bucket ${bucket} + su CMK KMS` : ''
    }). IRREVERSIBLE. ¿Continuar?`,
    default: false,
  });
  if (!ok) {
    console.log('Cancelado.');
    return;
  }
  if (bucket) {
    process.stdout.write(`Vaciando el bucket ${bucket}… `);
    const n = await emptyBucket(region, bucket);
    console.log(`${String(n)} objetos/versiones borrados.`);
  }
  await deleteStack(cfn, stackName);
  console.log('Borrando el stack (puede tardar varios minutos)…');
  await waitForStackDeleted(cfn, stackName, {
    onTick: (s) => {
      console.log(`  ${s}…`);
    },
  });
  console.log(
    `\n✅ Infraestructura eliminada.${bucket ? ' (La CMK de KMS queda programada para borrado ~7 días, deshabilitada.)' : ''}`
  );
}

/** Subcomandos SES post-provision: bifrost-provision ses-status|ses-activate|ses-suppressions|ses-pause|ses-resume */
async function sesCommand(): Promise<void> {
  const cmd = resolveSesCommand(process.argv);
  if (!cmd) return; // no debería pasar (entry sólo llama acá si resolveSesCommand !== null)
  const domain = await input({ message: 'Dominio de correo (ej: aulion.app)' });
  const region = await input({ message: 'Región AWS', default: 'us-east-1' });
  switch (cmd) {
    case 'ses-status':
      await runSesStatus(domain, region);
      break;
    case 'ses-activate': {
      const hz = orUndef(
        await input({
          message: 'HostedZoneId de Route53 (vacío = cargo el DNS a mano)',
          default: '',
        })
      );
      await runSesActivate(domain, region, { hostedZoneId: hz });
      break;
    }
    case 'ses-suppressions':
      await runSesSuppressions(region);
      break;
    case 'ses-pause':
      await runSesSending(domain, region, false);
      break;
    case 'ses-resume':
      await runSesSending(domain, region, true);
      break;
  }
}

const entry =
  process.argv[2] === 'destroy' ? destroy : resolveSesCommand(process.argv) ? sesCommand : main;
entry().catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
