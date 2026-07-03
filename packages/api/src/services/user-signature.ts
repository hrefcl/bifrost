import { getBranding, type BrandingConfig } from './branding.js';
import { getSignaturePolicy, resolveTemplateId } from './signature-policy.js';
import { externalizeDataImages } from './signature-images.js';
import {
  renderSignature,
  minimalPlainSignature,
  SIGNATURE_TEMPLATES,
  isValidTemplateId,
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
  const ctx = signatureContext(user, branding, pref?.includePhoto ?? true, baseUrl);

  // source ausente = legado 'custom' (respeta usuarios con defaultSignature ya guardada).
  const source = pref?.source ?? 'custom';

  // 'custom' permitido → usa el HTML pegado; si no hay, no firma (salvo enforce → cae a template).
  if (source === 'custom' && policy.allowCustomHtml) {
    let sig = user.preferences.defaultSignature?.trim();
    if (sig) {
      // Los clientes de correo bloquean data: en imágenes; externalizamos incluso el custom legacy.
      sig = await externalizeDataImages(userId, sig, baseUrl);
      return { html: sanitizeEmailHtml(sig), include: true };
    }
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

/** Arma el contexto de render (branding + datos del User). `includePhoto` decide si va la foto. */
function signatureContext(
  user: SignatureUser,
  branding: BrandingConfig,
  includePhoto: boolean,
  baseUrl: string
): SignatureContext {
  return {
    displayName: user.displayName,
    jobTitle: user.jobTitle,
    department: user.department,
    personalPhone: user.phone,
    photoUrl: includePhoto ? user.photoUrl : undefined,
    email: user.primaryEmail,
    companyName: branding.companyName,
    tagline: branding.tagline,
    logoUrl: branding.logoDataUrl,
    logoVerticalUrl: branding.logoVerticalDataUrl,
    logoWidthPx: branding.logoWidthPx,
    domainUrl: branding.domainUrl,
    companyPhone: branding.phone,
    address: branding.address,
    accentColor: branding.accentColor,
    socialLinks: branding.socialLinks,
    // Base para los iconos hosteados (`/sig-icons/*.png`). En email deben ser URLs absolutas.
    assetBase: baseUrl,
  };
}

/**
 * Renderiza un template ESPECÍFICO (para el preview en vivo de Ajustes), con los datos reales del
 * usuario + branding. El template pedido se acota a los permitidos por la política (mismo pipeline
 * render+externalize+sanitize que el envío → lo que se ve es lo que se manda). Fail-open a ''.
 */
/**
 * Rendiza TODOS los templates del catálogo con los datos del usuario+branding, SIN clamp de política
 * (para la galería visual del admin: se ven todos, habilitados o no). Fail-open por template a ''.
 */
export async function renderAllTemplates(
  user: SignatureUser,
  baseUrl: string
): Promise<{ id: string; nameKey: string; html: string }[]> {
  const branding = await getBranding();
  const ctx = signatureContext(user, branding, true, baseUrl);
  return Promise.all(
    SIGNATURE_TEMPLATES.map(async (t) => {
      let html = '';
      try {
        html = await externalizeDataImages(String(user._id), renderSignature(t.id, ctx), baseUrl);
        html = sanitizeEmailHtml(html);
      } catch {
        html = '';
      }
      return { id: t.id, nameKey: t.nameKey, html };
    })
  );
}

/**
 * Preview EN VIVO del editor del admin: rendiza `templateId` con el branding guardado MÁS overrides sin
 * persistir (color, logos, tagline, empresa) para ver los cambios mientras se editan. NO externaliza las
 * imágenes (el logo data: se muestra inline en el browser del admin; sólo el envío las hostea) → sin
 * crear imágenes por cada tecla. Fail-open a ''.
 */
export async function renderDraftPreview(
  user: SignatureUser,
  templateId: string,
  draft: Partial<BrandingConfig>,
  baseUrl: string
): Promise<string> {
  const branding = { ...(await getBranding()), ...draft };
  const id = isValidTemplateId(templateId) ? templateId : SIGNATURE_TEMPLATES[0].id;
  try {
    const ctx = signatureContext(user, branding, true, baseUrl);
    return sanitizeEmailHtml(renderSignature(id, ctx));
  } catch {
    return '';
  }
}

export async function renderPreview(
  user: SignatureUser,
  templateId: string,
  baseUrl: string,
  includePhoto = true
): Promise<string> {
  const [branding, policy] = await Promise.all([getBranding(), getSignaturePolicy()]);
  const effectiveId = resolveTemplateId(
    policy,
    policy.allowedTemplateIds.length && !policy.allowedTemplateIds.includes(templateId)
      ? undefined
      : templateId
  );
  try {
    const ctx = signatureContext(user, branding, includePhoto, baseUrl);
    let html = renderSignature(effectiveId, ctx);
    html = await externalizeDataImages(String(user._id), html, baseUrl);
    return sanitizeEmailHtml(html);
  } catch {
    return '';
  }
}
