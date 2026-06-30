// TEMP (no se commitea) — deploy real con los módulos del CLI: deployStack + polling de estado.
import { readFileSync } from 'node:fs';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { deployStack, getStackStatus, getStackOutputs } from '../dist/aws/cloudformation.js';

const OUT =
  '/private/tmp/claude-501/-Users-devuno-Href-webemail-bifrost/b9e36689-30a9-4225-89b9-94051b051ff8/scratchpad/deploy/';
const region = 'us-east-1';
const stackName = 'bifrost-aulion-app';

const templateBody = readFileSync(OUT + 'bifrost-stack.yaml', 'utf8');
const params = JSON.parse(readFileSync(OUT + 'params.json', 'utf8'));

const cfn = new CloudFormationClient({ region });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Desplegando stack ${stackName} en ${region}...`);
const result = await deployStack(cfn, { stackName, templateBody, params });
console.log(`CreateStack: ${result}`);

// Polling hasta estado terminal (CREATE_COMPLETE / *FAILED / ROLLBACK).
let last = '';
for (let i = 0; i < 120; i++) {
  const status = await getStackStatus(cfn, stackName);
  if (status !== last) {
    console.log(`  [${new Date().toISOString().slice(11, 19)}] ${status}`);
    last = status;
  }
  if (/COMPLETE$|FAILED$/.test(status) && status !== 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS') {
    if (status === 'CREATE_COMPLETE') {
      const outs = await getStackOutputs(cfn, stackName);
      console.log('\n✓ CREATE_COMPLETE');
      console.log('Outputs:', JSON.stringify(outs, null, 2));
    } else {
      console.log(`\n✗ Estado terminal: ${status}`);
    }
    process.exit(status === 'CREATE_COMPLETE' ? 0 : 1);
  }
  await sleep(15000);
}
console.log('Timeout esperando el stack.');
process.exit(2);
