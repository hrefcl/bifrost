import { getBranding } from './branding.js';
import { getSignaturePolicy, resolveTemplateId } from './signature-policy.js';
import { externalizeDataImages } from './signature-images.js';
import {
  renderSignature,
  minimalPlainSignature,
  type SignatureContext,
} from '../lib/signature-templates.js';
import { sanitizeEmailHtml } from '../lib/sanitizeHtml.js';

/** Campos del User que la firma necesita (subconjunto lean — no acopla al modelo entero). */
export interface SignatureUser {
  _id: unknown;
  displayName: string;
  primaryEmail: string;
  jobTitle?: string;
  department?: string;
  phone?: string;
  photoUrl?: string;
  preferences: {
    defaultSignature?: string;
    autoIncludeSignature?: boolean;
    signature?: { source?: 'template' | 'custom'; templateId?: string; includePhoto?: boolean };
  };
}

/**
 * Construye la firma efectiva del usuario al ENVIAR (firmas F5): rendiza el template elegido con el
 * branding vigente + los datos del User (white-label DINÁMICO), o usa el HTML 'custom' legado. Aplica
 * la política de empresa (template forzado, firma obligatoria, custom permitido). FAIL-OPEN: si el
 * render falla, cae a una firma mínima (si es obligatoria) o a sin firma — NUNCA lanza (no bloquea el
 * envío del correo). Devuelve `{ html, include }`.
 */
export async function buildUserSignature(
  user: SignatureUser,
  baseUrl: string
): Promise<{ html: string; include: boolean }> {
  const [branding, policy] = await Promise.all([getBranding(), getSignaturePolicy()]);
  const pref = user.preferences.signature;
  const include = (user.preferences.autoIncludeSignature ?? true) || policy.enforceSignature;
  if (!include) return { html: '', include: false };

  const userId = String(user._id);
  const ctx: SignatureContext = {
    displayName: user.displayName,
    jobTitle: user.jobTitle,
    department: user.department,
    personalPhone: user.phone,
    photoUrl: (pref?.includePhoto ?? true) ? user.photoUrl : undefined,
    email: user.primaryEmail,
    companyName: branding.companyName,
    tagline: branding.tagline,
    logoUrl: branding.logoDataUrl,
    logoWidthPx: branding.logoWidthPx,
    domainUrl: branding.domainUrl,
    companyPhone: branding.phone,
    address: branding.address,
    accentColor: branding.accentColor,
    socialLinks: branding.socialLinks,
  };

  // source ausente = legado 'custom' (respeta usuarios con defaultSignature ya guardada).
  const source = pref?.source ?? 'custom';

  // 'custom' permitido → usa el HTML pegado; si no hay, no firma (salvo enforce → cae a template).
  if (source === 'custom' && policy.allowCustomHtml) {
    const sig = user.preferences.defaultSignature?.trim();
    if (sig) return { html: sanitizeEmailHtml(sig), include: true };
    if (!policy.enforceSignature) return { html: '', include: false };
    // enforce sin custom → cae al render de template abajo.
  }

  // Render dinámico del template (source 'template', o custom prohibido/ausente con enforce).
  try {
    const templateId = resolveTemplateId(policy, pref?.templateId);
    let html = renderSignature(templateId, ctx);
    html = await externalizeDataImages(userId, html, baseUrl); // logo data: → URL hosteada
    html = sanitizeEmailHtml(html); // BACKSTOP (el render ya escapa; ver review H1)
    return { html, include: true };
  } catch {
    // FAIL-OPEN: nunca romper el envío. Si la firma es obligatoria, firma mínima en texto plano.
    if (policy.enforceSignature) {
      return { html: sanitizeEmailHtml(minimalPlainSignature(ctx)), include: true };
    }
    return { html: '', include: false };
  }
}
