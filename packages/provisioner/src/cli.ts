#!/usr/bin/env node
import { input, confirm, select, number } from '@inquirer/prompts';
import { writeFileSync } from 'node:fs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { listVpcs, listSubnets } from './aws/vpc.js';
import { ensureKeyPair } from './aws/compute.js';
import { buildUserData } from './mailserver/user-data.js';
import { buildStackTemplate, templateToYaml, templateToJson } from './infra/stack-template.js';
import { assembleStackParams, type WizardAnswers } from './wizard/params.js';
import { deployStack, getStackStatus, getStackOutputs } from './aws/cloudformation.js';
import { estimateMonthlyCost } from './cost.js';
import { recommendInstance } from './catalog/instance-types.js';
import { mailHostname } from './domain.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const slug = (s: string): string => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const orUndef = (s: string): string | undefined => (s === '' ? undefined : s);

function printDns(domain: string, ip: string): void {
  const host = mailHostname(domain);
  console.log('\nCargá estos registros DNS (en tu zona del dominio):');
  console.log(`  A     ${host}      → ${ip}`);
  console.log(`  MX    ${domain}    → ${host} (prioridad 10)`);
  console.log(`  TXT   ${domain}    → "v=spf1 mx -all"`);
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
  console.log('  • Teardown: borrá el stack (CloudFormation → Delete) y se va TODO.');
}

async function main(): Promise<void> {
  console.log('Bifrost — wizard de instalación (genera un CloudFormation y lo corre)\n');

  const domain = await input({ message: 'Dominio de correo (ej. empresa.com)' });
  const region = await input({ message: 'Región AWS', default: 'us-east-1' });
  const rec = recommendInstance();
  const instanceType = await input({ message: 'Tipo de EC2', default: rec.type });
  const useS3 = await confirm({
    message: '¿Crear repositorio S3 cifrado (bajo costo / escalable)?',
    default: true,
  });
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
  } else {
    keyName = await input({
      message:
        'Nombre de un key pair SSH EXISTENTE en tu cuenta (creá uno en la consola si no tenés)',
    });
  }

  // Armar user-data + parámetros + template, y escribir el YAML (el entregable).
  const userData = buildUserData({
    domain,
    mailHostname: mailHostname(domain),
    adminEmail: `admin@${domain}`,
    useS3,
  });
  const answers: WizardAnswers = {
    domain,
    instanceType,
    keyName,
    userData,
    useS3,
    existingVpcId: orUndef(existingVpcId),
    existingSubnetId: orUndef(existingSubnetId),
  };
  const params = assembleStackParams(answers);
  const file = `bifrost-stack-${slug(domain)}.yaml`;
  writeFileSync(file, templateToYaml(buildStackTemplate()));
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

  const stackName = `bifrost-${slug(domain)}`;
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
      console.log(`\nStack ${action}: ${stackName}. Esperando a que termine…`);
      let status = (await getStackStatus(cfn, stackName)) ?? 'UNKNOWN';
      while (status.endsWith('IN_PROGRESS')) {
        await sleep(10_000);
        status = (await getStackStatus(cfn, stackName)) ?? 'UNKNOWN';
        console.log(`  estado: ${status}`);
      }
      if (status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE') {
        const out = await getStackOutputs(cfn, stackName);
        console.log(`\n✓ Listo. IP pública: ${out.PublicIp ?? '(ver en la consola)'}`);
        printDns(domain, out.PublicIp ?? 'TU_IP');
      } else {
        console.log(`\n✗ El stack terminó en ${status}. Revisá los eventos en la consola web.`);
      }
      return;
    }
  }

  // No se corrió → instrucciones para que lo haga el usuario.
  printInstructions(file, stackName, region);
}

main().catch((err: unknown) => {
  console.error('Error en el wizard:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
