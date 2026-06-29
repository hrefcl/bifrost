/**
 * Emite los DOS artefactos del turnkey a un directorio, para validarlos con sus linters reales
 * (cfn-lint el template CloudFormation, shellcheck el user-data bash). Lo usa el gate de CI y se puede
 * correr a mano: `node packages/provisioner/scripts/emit-artifacts.mjs <outDir>`.
 *
 * Importa desde dist/ (el provisioner se compila con `pnpm build` antes de correr esto).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStackTemplate, templateToYaml } from '../dist/infra/stack-template.js';
import { buildUserData } from '../dist/mailserver/user-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });

const userData = buildUserData({
  domain: 'example.com',
  mailHostname: 'mail.example.com',
  adminEmail: 'admin@example.com',
  stackName: 'bifrost-example-com',
  region: 'us-east-1',
});

// Validamos la forma REAL que se despliega: con el user-data EMBEBIDO (no el parámetro), igual que el
// wizard/deploy → así cfn-lint valida exactamente lo que CloudFormation va a recibir.
writeFileSync(join(outDir, 'bifrost-stack.yaml'), templateToYaml(buildStackTemplate(userData)));
writeFileSync(join(outDir, 'user-data.sh'), userData);

console.log(`Artefactos del turnkey emitidos en ${outDir} (bifrost-stack.yaml + user-data.sh)`);
