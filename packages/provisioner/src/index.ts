/**
 * `@webmail6/provisioner` — wizard que aprovisiona un servidor de correo all-in-one en AWS
 * (docker-mailserver + Bifrost) con S3 cifrado opcional, vía CloudFormation: pregunta → arma el
 * template → lo corre (o entrega el YAML). Ver `docs/cli-provisioning-aws.md`.
 */
export { runPreflight, type PreflightInput, type PreflightResult } from './steps/preflight.js';
export { makeClients, type AwsClients } from './aws/clients.js';
export { validateDomain, mailHostname } from './domain.js';
export { validateBucketName, type BucketNameCheck } from './s3-naming.js';
export {
  ALLINONE_CATALOG,
  RECOMMENDED_INSTANCE,
  recommendInstance,
  type InstanceTypeInfo,
} from './catalog/instance-types.js';
export { type AwsIdentity } from './aws/sts.js';
export { estimateMonthlyCost, PRICING, type CostInput, type CostBreakdown } from './cost.js';
export { buildUserData, type UserDataInput } from './mailserver/user-data.js';
export {
  buildStackTemplate,
  templateToYaml,
  templateToJson,
  MAIL_INGRESS_PORTS,
} from './infra/stack-template.js';
export { listVpcs, listSubnets, type VpcInfo, type SubnetInfo } from './aws/vpc.js';
export {
  deployStack,
  getStackOutputs,
  getStackStatus,
  deleteStack,
  stackExists,
  type StackParameter,
  type DeployStackInput,
} from './aws/cloudformation.js';
export { ensureKeyPair, type KeyPairResult } from './aws/compute.js';
export { projectTags, tagSpec, PROJECT, MANAGED_BY } from './tags.js';
export { assembleStackParams, deriveBucketName, type WizardAnswers } from './wizard/params.js';
