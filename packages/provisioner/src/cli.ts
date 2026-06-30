#!/usr/bin/env node
import { input, confirm, select, number } from '@inquirer/prompts';
import { writeFileSync } from 'node:fs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { Route53Client } from '@aws-sdk/client-route-53';
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
import { recommendInstance } from './catalog/instance-types.js';
import { mailHostname, validateDomain } from './domain.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const slug = (s: string): string => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const orUndef = (s: string): string | undefined => (s === '' ? undefined : s);

function printDns(domain: string, ip: string): void {
  const host = mailHostname(domain);
  console.log('\nCargá estos registros DNS (en tu zona del dominio):');
  console.log(`  A     ${host}        → ${ip}`);
  console.log(`  A     webmail.${domain} → ${ip}  (la UI web / TLS)`);
  console.log(`  MX    ${domain}      → ${host} (prioridad 10)`);
  console.log(`  TXT   ${domain}      → "v=spf1 mx ~all"`);
  console.log(`  TXT   _dmarc.${domain} → "v=DMARC1; p=quarantine"`);
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
  const rec = recommendInstance();
  const instanceType = await input({ message: 'Tipo de EC2', default: rec.type });
  const useS3 = await confirm({
    message:
      '¿Guardar los adjuntos en S3 cifrado? (la palanca de costo: bucket+KMS, la app lo usa vía el rol del EC2; recursos facturables)',
    default: true,
  });
  const sshCidr = await input({
    message: 'CIDR permitido para SSH (recomendado TU_IP/32; Enter = 0.0.0.0/0 ABIERTO a internet)',
    default: '0.0.0.0/0',
  });
  if (sshCidr === '0.0.0.0/0') {
    console.log('⚠ SSH quedará ABIERTO a internet (0.0.0.0/0). Considerá restringir a tu IP/32.');
  }
  const mailboxes = (await number({ message: '¿Cuántos buzones/empleados?', default: 50 })) ?? 50;

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
    instanceMonthlyUsd: rec.approxMonthlyUsd,
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

  if (connect) {
    const run = await confirm({
      message: '¿Corro el stack AHORA? (crea recursos REALES y factura)',
      default: false,
    });
    if (run) {
      const cfn = new CloudFormationClient({ region });
      const action = await deployStack(cfn, {
        stackName,
        templateBody: templateToJson(buildStackTemplate()),
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
            '  Los registros DNS (A/MX/webmail/SPF/DMARC) se crearon en tu zona Route53.'
          );
          console.log('  (El DKIM se genera en el servidor; lo agregás después.)');
        } else {
          printDns(domain, out.PublicIp ?? 'TU_IP');
        }
        console.log(
          '\n⚠ ENVÍO SALIENTE en AWS (importante): AWS BLOQUEA el puerto 25 saliente por'
        );
        console.log(
          '  defecto. Vas a RECIBIR correo, pero para ENVIAR a internet tenés 2 opciones:'
        );
        console.log(
          '   1) Pedir a AWS el desbloqueo del puerto 25 (formulario de soporte, 24-48h) → envío'
        );
        console.log('      directo self-hosted.');
        console.log(
          '   2) RELAY por Amazon SES (recomendado, inmediato): configurá RELAY_HOST/USER/PASSWORD'
        );
        console.log(
          '      en el mailserver con credenciales SMTP de SES. OJO: una cuenta SES nueva está en'
        );
        console.log(
          '      SANDBOX → sólo entrega a destinatarios VERIFICADOS. Para enviar a CUALQUIERA hay que'
        );
        console.log(
          '      pedir "production access" a SES (sale del sandbox; suele aprobarse para bajo volumen).'
        );
        console.log('⚠ Falta crear los buzones y el DKIM en el servidor (SSH al box) — fase F-E5.');
      } else if (status.endsWith('IN_PROGRESS')) {
        console.log(`\n⏱ Timeout de espera; el stack sigue en ${status}. Seguí en la consola web.`);
      } else {
        console.log(`\n✗ El stack terminó en ${status}. Revisá los eventos en la consola web.`);
      }
      return;
    }
  }

  // No se corrió → instrucciones para que lo haga el usuario.
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

const entry = process.argv[2] === 'destroy' ? destroy : main;
entry().catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
