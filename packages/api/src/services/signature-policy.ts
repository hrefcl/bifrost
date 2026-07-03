import { SystemConfig } from '../models/SystemConfig.js';
import { SIGNATURE_TEMPLATE_IDS, isValidTemplateId } from '../lib/signature-templates.js';

/**
 * Política de firmas de empresa (firmas F6). Singleton en `SystemConfig` (patrón calendarDefaults).
 * El bloqueo de color (`lockAccentColor`) NO vive acá: es de branding (F1), lo consume el front.
 */
const KEY = 'signaturePolicy';

export interface SignaturePolicy {
  /** Subconjunto del catálogo habilitado. `[]` = todos. SIEMPRE filtra lo que el usuario elige. */
  allowedTemplateIds: string[];
  /** true → el usuario no elige; se usa `allowedTemplateIds[0]` (obligatorio ≥1). */
  lockTemplate: boolean;
  /** true → firma corporativa SIEMPRE (autoInclude forzado on). */
  enforceSignature: boolean;
  /** false → prohíbe `source:'custom'` (HTML pegado). */
  allowCustomHtml: boolean;
}

const DEFAULT: SignaturePolicy = {
  allowedTemplateIds: [],
  lockTemplate: false,
  enforceSignature: false,
  allowCustomHtml: true,
};

export class SignaturePolicyError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SignaturePolicyError';
  }
}

export async function getSignaturePolicy(): Promise<SignaturePolicy> {
  const doc = await SystemConfig.findOne({ key: KEY }).lean<{
    value?: Partial<SignaturePolicy>;
  } | null>();
  const v: Partial<SignaturePolicy> = doc?.value ?? {};
  // Deep-merge defensivo (docs viejos/parciales no rompen) + sanitiza ids contra el catálogo (stale fuera).
  return {
    allowedTemplateIds: Array.isArray(v.allowedTemplateIds)
      ? [...new Set(v.allowedTemplateIds.filter(isValidTemplateId))]
      : DEFAULT.allowedTemplateIds,
    lockTemplate: v.lockTemplate ?? DEFAULT.lockTemplate,
    enforceSignature: v.enforceSignature ?? DEFAULT.enforceSignature,
    allowCustomHtml: v.allowCustomHtml ?? DEFAULT.allowCustomHtml,
  };
}

/**
 * Mergea + sanitiza + VALIDA el invariante SIN escribir. Lanza `SignaturePolicyError` (400) si viola
 * `lockTemplate ⇒ ≥1 template válido`. Permite validar la política ANTES de escribir el branding en el
 * endpoint combinado (review B/C/D M1: evita persistir branding y que luego falle la política → estado
 * inconsistente).
 */
export async function resolveSignaturePolicy(
  patch: Partial<SignaturePolicy>
): Promise<SignaturePolicy> {
  const next: SignaturePolicy = { ...(await getSignaturePolicy()), ...patch };
  const ids = Array.isArray(next.allowedTemplateIds) ? next.allowedTemplateIds : [];
  next.allowedTemplateIds = [...new Set(ids.filter(isValidTemplateId))];
  if (next.lockTemplate && next.allowedTemplateIds.length === 0) {
    throw new SignaturePolicyError('lockTemplate requiere al menos un template permitido válido.');
  }
  return next;
}

/** Persiste una política YA resuelta (sin re-validar). */
export async function writeSignaturePolicy(resolved: SignaturePolicy): Promise<SignaturePolicy> {
  await SystemConfig.findOneAndUpdate(
    { key: KEY },
    { $set: { value: resolved } },
    { upsert: true }
  );
  return resolved;
}

export async function setSignaturePolicy(
  patch: Partial<SignaturePolicy>
): Promise<SignaturePolicy> {
  return writeSignaturePolicy(await resolveSignaturePolicy(patch));
}

/** Resuelve el template EFECTIVO para un usuario según la política (siempre devuelve un id válido). */
export function resolveTemplateId(
  policy: SignaturePolicy,
  userTemplateId: string | undefined
): string {
  const allowed = policy.allowedTemplateIds.length
    ? policy.allowedTemplateIds
    : [...SIGNATURE_TEMPLATE_IDS];
  if (policy.lockTemplate) return allowed[0];
  if (userTemplateId && allowed.includes(userTemplateId)) return userTemplateId;
  return allowed[0];
}
