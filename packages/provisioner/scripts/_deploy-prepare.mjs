// TEMP driver (no se commitea) — mismos módulos del CLI, modo conectado. Paso 3: keypair + template
// + params para aulion.app en Graviton (t4g.large). NO despliega.
import { writeFileSync } from 'node:fs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ensureKeyPair } from '../dist/aws/compute.js';
import { buildUserData } from '../dist/mailserver/user-data.js';
import { buildStackTemplate, templateToYaml } from '../dist/infra/stack-template.js';
import { assembleStackParams } from '../dist/wizard/params.js';
import { mailHostname } from '../dist/domain.js';

const OUT =
  '/private/tmp/claude-501/-Users-devuno-Href-webemail-bifrost/b9e36689-30a9-4225-89b9-94051b051ff8/scratchpad/deploy/';
const domain = 'aulion.app';
const region = 'us-east-1';
const instanceType = 't4g.large'; // Graviton (arm64) — más barato
const sshCidr = '186.107.74.52/32';
const keyName = 'bifrost-aulion-app';

const ec2 = new EC2Client({ region });
const kp = await ensureKeyPair(ec2, { name: keyName, domain });
if (kp.privateKeyPem) {
  writeFileSync(OUT + 'bifrost-aulion-app.pem', kp.privateKeyPem, { mode: 0o600 });
  console.log(`✓ Keypair CREADO: ${kp.keyName}`);
} else console.log(`✓ Keypair ya existía: ${kp.keyName}`);

const userData = buildUserData({
  domain,
  mailHostname: mailHostname(domain),
  adminEmail: `admin@${domain}`,
  stackName: 'bifrost-aulion-app',
  region,
});
const params = assembleStackParams({
  domain,
  instanceType,
  keyName,
  userData,
  useS3: false,
  hostedZoneId: undefined, // sin DNS por CFN (preserva SES)
  sshCidr,
});
writeFileSync(OUT + 'bifrost-stack.yaml', templateToYaml(buildStackTemplate(userData)));
writeFileSync(OUT + 'params.json', JSON.stringify(params, null, 2));
console.log('✓ Template + params escritos (t4g.large / arm64).');
for (const p of params) {
  const v = p.key === 'UserData' ? `<bash ${String(p.value.length)} chars>` : p.value;
  console.log(`  ${p.key} = ${v}`);
}
