import {
  CloudFormationClient,
  CreateStackCommand,
  UpdateStackCommand,
  DescribeStacksCommand,
  DeleteStackCommand,
} from '@aws-sdk/client-cloudformation';

/** Parámetro del stack (lo que el CLI arma a partir de las preguntas). */
export interface StackParameter {
  key: string;
  value: string;
}

function toCfnParams(params: StackParameter[]): { ParameterKey: string; ParameterValue: string }[] {
  return params.map((p) => ({ ParameterKey: p.key, ParameterValue: p.value }));
}

/** True si el mensaje de error de CloudFormation indica que el stack no existe (vs otro error). */
function isDoesNotExist(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /does not exist/i.test(msg);
}

export async function stackExists(cfn: CloudFormationClient, stackName: string): Promise<boolean> {
  try {
    const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    return (res.Stacks ?? []).length > 0;
  } catch (err) {
    if (isDoesNotExist(err)) return false;
    throw err; // permisos/throttling/red NO deben interpretarse como "no existe"
  }
}

export interface DeployStackInput {
  stackName: string;
  templateBody: string;
  params: StackParameter[];
}

/**
 * Despliega el stack: lo CREA si no existe, o lo ACTUALIZA si ya existe (idempotente — re-correr no
 * duplica). `OnFailure: DELETE` en la creación → si algo falla, CloudFormation limpia solo (no deja
 * un stack a medias). Devuelve la acción tomada. CAPABILITY_NAMED_IAM para cuando el template sume
 * el instance profile de S3 (hoy no crea IAM, pero pasarla de más es inocuo).
 */
export async function deployStack(
  cfn: CloudFormationClient,
  input: DeployStackInput
): Promise<'created' | 'updated' | 'unchanged'> {
  if (await stackExists(cfn, input.stackName)) {
    try {
      await cfn.send(
        new UpdateStackCommand({
          StackName: input.stackName,
          TemplateBody: input.templateBody,
          Parameters: toCfnParams(input.params),
          Capabilities: ['CAPABILITY_NAMED_IAM'],
        })
      );
      return 'updated';
    } catch (err) {
      // UpdateStack sin diferencias tira ValidationError "No updates are to be performed" — eso es
      // un re-run idempotente, NO un fallo. Cualquier otro error sí se propaga.
      const msg = err instanceof Error ? err.message : String(err);
      if (/No updates are to be performed/i.test(msg)) return 'unchanged';
      throw err;
    }
  }
  await cfn.send(
    new CreateStackCommand({
      StackName: input.stackName,
      TemplateBody: input.templateBody,
      Parameters: toCfnParams(input.params),
      Capabilities: ['CAPABILITY_NAMED_IAM'],
      // Default DELETE (limpia solo si falla). BIFROST_KEEP_ON_FAILURE=1 (DEBUG) → DO_NOTHING: deja las
      // instancias fallidas vivas para leer su cloud-init log (diagnóstico del from-zero). No para prod.
      OnFailure: process.env.BIFROST_KEEP_ON_FAILURE ? 'DO_NOTHING' : 'DELETE',
    })
  );
  return 'created';
}

/** Estado actual del stack (para que el CLI haga polling hasta *_COMPLETE), o null si no existe. */
export async function getStackStatus(
  cfn: CloudFormationClient,
  stackName: string
): Promise<string | null> {
  try {
    const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    return res.Stacks?.[0]?.StackStatus ?? null;
  } catch {
    return null;
  }
}

/**
 * Outputs del stack (PublicIp, InstanceId, VpcId) cuando terminó. El tipo de acceso es
 * `string | undefined` a propósito: una key puede no estar presente (output condicional, stack a
 * medias) y el caller debe contemplarlo.
 */
export async function getStackOutputs(
  cfn: CloudFormationClient,
  stackName: string
): Promise<Record<string, string | undefined>> {
  let res;
  try {
    res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  } catch (err) {
    if (isDoesNotExist(err)) return {}; // stack borrado (p.ej. OnFailure: DELETE) → sin outputs
    throw err;
  }
  const out: Record<string, string> = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) {
    if (o.OutputKey && o.OutputValue) out[o.OutputKey] = o.OutputValue;
  }
  return out;
}

/** Teardown = borrar el stack (CloudFormation destruye TODO lo del stack, sin huérfanos). */
export async function deleteStack(cfn: CloudFormationClient, stackName: string): Promise<void> {
  await cfn.send(new DeleteStackCommand({ StackName: stackName }));
}

/**
 * Espera a que el stack termine de borrarse. Devuelve cuando ya no existe (getStackStatus = null) o
 * DELETE_COMPLETE. Lanza ante DELETE_FAILED (típico: un recurso retenido o un bucket no vacío que no se
 * vació antes) o timeout. `onTick` reporta progreso.
 */
export async function waitForStackDeleted(
  cfn: CloudFormationClient,
  stackName: string,
  opts: { timeoutMs?: number; pollMs?: number; onTick?: (status: string) => void } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 25 * 60 * 1000;
  const pollMs = opts.pollMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await getStackStatus(cfn, stackName);
    if (status === null || status === 'DELETE_COMPLETE') return;
    if (status === 'DELETE_FAILED') {
      throw new Error(
        `El stack ${stackName} quedó en DELETE_FAILED (revisá recursos retenidos o un bucket no vacío).`
      );
    }
    if (Date.now() > deadline) throw new Error(`Timeout esperando el borrado de ${stackName}.`);
    opts.onTick?.(status);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
