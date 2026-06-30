import {
  SESv2Client,
  GetAccountCommand,
  PutAccountSuppressionAttributesCommand,
  CreateConfigurationSetCommand,
  PutConfigurationSetSendingOptionsCommand,
  ListSuppressedDestinationsCommand,
  type SuppressionListReason,
} from '@aws-sdk/client-sesv2';

/**
 * Protección de reputación / manejo de bounces-complaints — el mecanismo que baja el HIGH #7
 * (suspensión de cuenta) a MED aceptado. Ver docs/diseno-ses-turnkey.md §6. Capas:
 *   - Suppression list a nivel cuenta (SES deja de enviar a addresses que rebotaron/se quejaron).
 *   - Configuration set con métricas de reputación (alimenta el auto-pause de §6).
 *   - pause/resume del envío (override manual + lo que llama la Lambda de auto-pause).
 *   - Listado de suprimidos (visibilidad para el operador).
 * El auto-pause automático (CloudWatch→SNS→Lambda) se provisiona aparte; este módulo es su base de API.
 */

export const REQUIRED_SUPPRESSION_REASONS: SuppressionListReason[] = ['BOUNCE', 'COMPLAINT'];

/**
 * Une las razones de supresión existentes con las requeridas, SIN duplicar y de forma determinística.
 * PURA. Clave para NO pisar la config de cuenta del operador (merge, no overwrite). [D-MED]
 */
export function mergeSuppressedReasons(
  existing: readonly string[] | undefined,
  required: readonly string[]
): SuppressionListReason[] {
  const set = new Set<string>([...(existing ?? []), ...required]);
  // Orden estable (no depende del orden de entrada) → comparaciones idempotentes y diffs limpios.
  return [...set].sort() as SuppressionListReason[];
}

/**
 * Activa la suppression list a nivel cuenta para BOUNCE+COMPLAINT, **mergeando** con lo que el operador
 * ya tuviera (no sobrescribe). Idempotente: si ya es un superconjunto, no llama a Put. Devuelve si cambió.
 */
export async function ensureAccountSuppression(ses: SESv2Client): Promise<{ changed: boolean }> {
  const acct = await ses.send(new GetAccountCommand({}));
  const existing = acct.SuppressionAttributes?.SuppressedReasons ?? [];
  const merged = mergeSuppressedReasons(existing, REQUIRED_SUPPRESSION_REASONS);

  // Idempotencia: sólo escribe si falta alguna razón requerida (no toca si ya está todo).
  const existingSet = new Set(existing);
  const needsUpdate = merged.some((r) => !existingSet.has(r));
  if (!needsUpdate) return { changed: false };

  await ses.send(new PutAccountSuppressionAttributesCommand({ SuppressedReasons: merged }));
  return { changed: true };
}

/**
 * Crea el configuration set con métricas de reputación + supresión a nivel set; idempotente
 * (AlreadyExists se tolera). El default-de-identidad se fija aparte (ses-identity.setDefaultConfigurationSet).
 */
export async function ensureConfigurationSet(ses: SESv2Client, name: string): Promise<void> {
  try {
    await ses.send(
      new CreateConfigurationSetCommand({
        ConfigurationSetName: name,
        ReputationOptions: { ReputationMetricsEnabled: true },
        SuppressionOptions: { SuppressedReasons: REQUIRED_SUPPRESSION_REASONS },
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'AlreadyExistsException') throw err;
  }
}

/** Pausa (false) o reanuda (true) el envío del configuration set. Lo usa el auto-pause y `pause-outbound`. */
export async function setSendingEnabled(
  ses: SESv2Client,
  configurationSetName: string,
  enabled: boolean
): Promise<void> {
  await ses.send(
    new PutConfigurationSetSendingOptionsCommand({
      ConfigurationSetName: configurationSetName,
      SendingEnabled: enabled,
    })
  );
}

export interface SuppressedEntry {
  email: string;
  reason: string;
}

/** Lista todas las addresses suprimidas (paginado completo) — visibilidad para el operador. */
export async function listSuppressed(ses: SESv2Client): Promise<SuppressedEntry[]> {
  const out: SuppressedEntry[] = [];
  let token: string | undefined;
  do {
    const res = await ses.send(
      new ListSuppressedDestinationsCommand(token ? { NextToken: token } : {})
    );
    for (const d of res.SuppressedDestinationSummaries ?? []) {
      if (d.EmailAddress) out.push({ email: d.EmailAddress, reason: d.Reason ?? 'UNKNOWN' });
    }
    token = res.NextToken;
  } while (token);
  return out;
}
