/**
 * `@webmail6/provisioner` — CLI para aprovisionar un servidor de correo all-in-one en AWS
 * (docker-mailserver + Bifrost) con repositorio de datos opcional en S3 cifrado (SSE-KMS).
 * Ver `docs/cli-provisioning-aws.md`. Esta fase (F-E1) expone sólo el PREFLIGHT read-only.
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
