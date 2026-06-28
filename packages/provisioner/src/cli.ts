#!/usr/bin/env node
import { input, confirm } from '@inquirer/prompts';
import { makeClients } from './aws/clients.js';
import { runPreflight } from './steps/preflight.js';
import { ALLINONE_CATALOG } from './catalog/instance-types.js';

/**
 * F-E1 — Preflight interactivo (read-only). Reúne región/dominio/S3, valida contra AWS sin crear
 * nada y muestra el resultado + avisos. Las fases siguientes (crear recursos) van detrás de
 * confirmaciones explícitas y aún no están implementadas.
 */
async function main(): Promise<void> {
  console.log('Bifrost — aprovisionamiento AWS · F-E1 (preflight read-only, no factura)\n');

  const region = await input({ message: 'Región AWS', default: 'us-east-1' });
  const domain = await input({ message: 'Dominio de correo (p. ej. tuempresa.com)' });
  const useS3 = await confirm({
    message: '¿Usar S3 (SSE-KMS) como repositorio de datos cifrado?',
    default: true,
  });
  let bucketName: string | undefined;
  if (useS3) {
    const suggested = `bifrost-${domain.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-data`;
    bucketName = await input({ message: 'Nombre del bucket S3', default: suggested });
  }

  console.log('\nValidando contra AWS (sólo lectura)…\n');
  // Región de CONTROL estable para las llamadas; `region` es el destino (se valida como dato).
  const clients = makeClients();
  const r = await runPreflight(clients, { region, domain, useS3, bucketName });

  console.log(`Cuenta AWS:  ${r.identity.accountId}  (${r.identity.arn})`);
  console.log(`Región:      ${r.region.value} ${r.region.valid ? '✓' : '✗ no habilitada'}`);
  console.log(
    `Dominio:     ${r.domain.value} ${r.domain.valid ? '✓' : '✗'}` +
      (r.domain.valid ? `  → ${r.domain.mailHostname}` : '')
  );
  const r53Status = r.domain.hostedZoneExists
    ? `zona existente (${r.domain.hostedZoneId ?? ''})`
    : r.domain.parentZone
      ? `usará la zona padre ${r.domain.parentZone.name} (${r.domain.parentZone.id})`
      : 'no existe (se creará)';
  console.log(`Route53:     ${r53Status}`);
  if (r.s3.enabled) {
    console.log(
      `Bucket S3:   ${r.s3.bucketName ?? ''} ${r.s3.bucketNameValid ? '✓' : `✗ ${r.s3.bucketNameReason ?? ''}`}`
    );
  }

  const rec = r.recommendedInstance;
  console.log(
    `\nEC2 recomendado (all-in-one): ${rec.type} — ${String(rec.vcpu)} vCPU / ${String(rec.memGiB)} GB — ~$${String(rec.approxMonthlyUsd)}/mes`
  );
  console.log('Opciones:');
  for (const i of ALLINONE_CATALOG) {
    console.log(
      `  - ${i.type}: ${String(i.vcpu)} vCPU / ${String(i.memGiB)} GB — ~$${String(i.approxMonthlyUsd)}/mes (${i.note})`
    );
  }

  if (r.warnings.length > 0) {
    console.log('\nAvisos:');
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  } else {
    console.log('\nPreflight OK, sin avisos.');
  }
  console.log(
    '\n(F-E1: hasta acá NO se creó ni facturó nada. Las fases siguientes crean recursos con confirmación.)'
  );
}

main().catch((err: unknown) => {
  console.error('Error en el preflight:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
