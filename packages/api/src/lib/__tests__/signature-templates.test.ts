import { describe, it, expect } from 'vitest';
import {
  SIGNATURE_TEMPLATES,
  SIGNATURE_TEMPLATE_IDS,
  renderSignature,
  isValidTemplateId,
  minimalPlainSignature,
  type SignatureContext,
} from '../signature-templates.js';
import { sanitizeEmailHtml } from '../sanitizeHtml.js';

const base: SignatureContext = {
  displayName: 'Ana Pérez',
  jobTitle: 'Gerente',
  department: 'Comercial',
  personalPhone: '+56 9 1234 5678',
  email: 'ana@aulion.app',
  companyName: 'Aulion',
  tagline: 'Tu correo, tu marca',
  logoUrl: '/api/signature-images/0123456789abcdef01234567',
  domainUrl: 'https://aulion.app',
  companyPhone: '+56 2 2345 6789',
  address: 'Santiago, CL',
  accentColor: '#1b66ff',
  socialLinks: { linkedin: 'https://linkedin.com/company/aulion', x: 'https://x.com/aulion' },
};

describe('signature-templates (F2)', () => {
  it('cada template rendiza sin lanzar, con el nombre, y sobrevive a sanitizeEmailHtml', () => {
    for (const t of SIGNATURE_TEMPLATES) {
      const html = renderSignature(t.id, base);
      expect(html, t.id).toContain('Ana Pérez');
      expect(html, t.id).toContain('aulion.app'); // host del dominio
      // El HTML es email-safe: pasa por el sanitizer sin quedar vacío.
      expect(sanitizeEmailHtml(html).length, t.id).toBeGreaterThan(20);
    }
  });

  it('id inválido → cae al primer template del catálogo (no lanza)', () => {
    const html = renderSignature('no-existe', base);
    expect(html).toContain('Ana Pérez');
  });

  it('isValidTemplateId reconoce el catálogo', () => {
    expect(SIGNATURE_TEMPLATE_IDS.every(isValidTemplateId)).toBe(true);
    expect(isValidTemplateId('bogus')).toBe(false);
  });

  it('XSS: escapa campos no confiables en TODOS los templates (nombre/cargo/email)', () => {
    const evil: SignatureContext = {
      ...base,
      displayName: '<script>alert(1)</script>',
      jobTitle: '"><img src=x onerror=alert(1)>',
      email: 'x@y.com"><script>bad()</script>',
    };
    for (const t of SIGNATURE_TEMPLATES) {
      const html = renderSignature(t.id, evil);
      // Ningún tag inyectado sobrevive con su `<` crudo → no es ejecutable.
      expect(html, t.id).not.toContain('<script>');
      expect(html, t.id).not.toContain('<img src=x'); // el `<` del ataque quedó como &lt;
      // Prueba positiva de neutralización: los tags inyectados quedaron como TEXTO escapado.
      expect(html, t.id).toContain('&lt;script&gt;'); // displayName
      expect(html, t.id).toContain('&lt;img src=x onerror'); // jobTitle escapado
      // El `"` del email no rompe el atributo href (queda &quot;).
      expect(html, t.id).not.toMatch(/href="mailto:[^"]*"><script>/);
    }
  });

  it('XSS: escapa TODOS los campos de texto interpolados (regresión por-campo)', () => {
    const XSS = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
    const textFields: (keyof SignatureContext)[] = [
      'displayName',
      'jobTitle',
      'department',
      'companyName',
      'tagline',
      'address',
      'personalPhone',
      'companyPhone',
      'email',
    ];
    for (const f of textFields) {
      const ctx = { ...base, [f]: XSS } as SignatureContext;
      for (const t of SIGNATURE_TEMPLATES) {
        const html = renderSignature(t.id, ctx);
        expect(html, `${t.id}/${f}: <script>`).not.toContain('<script>');
        expect(html, `${t.id}/${f}: <img`).not.toContain('<img src=x');
        expect(html, `${t.id}/${f}: onerror`).not.toMatch(/onerror=alert\(1\)>/);
      }
    }
    // socialLinks con esquema peligroso → cae a nada (link() valida el esquema); sin vectores en el HTML.
    const socialEvil = {
      ...base,
      socialLinks: { linkedin: 'javascript:alert(1)', x: 'data:text/html,<script>x</script>' },
    } as SignatureContext;
    for (const t of SIGNATURE_TEMPLATES) {
      const html = renderSignature(t.id, socialEvil);
      expect(html, `${t.id}: no javascript:`).not.toContain('javascript:');
      expect(html, `${t.id}: no data:text/html`).not.toContain('data:text/html');
    }
  });

  it('tel: en teléfono sobrevive al sanitizer (esquema permitido)', () => {
    const ctx: SignatureContext = {
      ...base,
      personalPhone: '+56 9 1234 5678',
      domainUrl: undefined,
      socialLinks: {},
    };
    const html = renderSignature('clasica', ctx);
    const sanitized = sanitizeEmailHtml(html);
    expect(sanitized).toContain('href="tel:+56 9 1234 5678"');
  });

  it('URL insegura en domainUrl/social → NO produce href javascript:/data:', () => {
    const evil: SignatureContext = {
      ...base,
      domainUrl: 'javascript:alert(1)',
      socialLinks: { linkedin: 'data:text/html,<script>x</script>' },
    };
    for (const t of SIGNATURE_TEMPLATES) {
      const html = renderSignature(t.id, evil);
      expect(html, t.id).not.toContain('javascript:');
      expect(html, t.id).not.toContain('data:text/html');
    }
  });

  it('photoUrl sólo se usa si es http/https/interna (esquemas peligrosos se omiten)', () => {
    const evil = { ...base, photoUrl: 'javascript:alert(1)' };
    const html = renderSignature('clasica', evil);
    expect(html).not.toContain('javascript:');
    // Con photoUrl válida (interna) sí aparece el <img>.
    const ok = renderSignature('clasica', {
      ...base,
      photoUrl: '/api/signature-images/0123456789abcdef01234567',
    });
    expect(ok).toContain('<img');
  });

  it('accentColor no-hex se ignora (no rompe el atributo style)', () => {
    const evil = { ...base, accentColor: 'red;position:absolute;left:0' };
    const html = renderSignature('moderna', evil);
    expect(html).not.toContain('position:absolute');
    expect(html).toContain('#1b66ff'); // cae al default
  });

  it('campos ausentes → render graceful (sin foto/logo/redes, sin romper)', () => {
    const minimalCtx: SignatureContext = { displayName: 'Solo Nombre', email: 'solo@x.com' };
    for (const t of SIGNATURE_TEMPLATES) {
      const html = renderSignature(t.id, minimalCtx);
      expect(html, t.id).toContain('Solo Nombre');
      expect(html, t.id).not.toContain('<img'); // sin foto ni logo
    }
  });

  it('minimalPlainSignature: fallback sin imágenes, escapado', () => {
    const html = minimalPlainSignature({ ...base, displayName: '<b>x</b>' });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('Aulion');
  });

  // ── Hardening del review B/C/D del render (escape-at-origin al 100%) ──

  it('assetBase se escapa: un `"` no puede romper el atributo src del icono', () => {
    const html = renderSignature('clasica', {
      ...base,
      assetBase: 'https://x.test/"><script>alert(1)</script>',
      personalPhone: '+56 9 1111 2222', // fuerza un contactRow con icono hosteado
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('"><script'); // el `"` quedó escapado, no rompió el atributo
  });

  it('avatar usa 2 iniciales (primera + última del nombre)', () => {
    const html = renderSignature('clasica', { ...base, photoUrl: undefined });
    expect(html).toContain('>AP<'); // "Ana Pérez" → AP
    // un solo nombre → una inicial
    const one = renderSignature('clasica', { displayName: 'Cleverty', email: 'x@y.com' });
    expect(one).toContain('>C<');
  });

  it('cleverty: badges App Store/Google Play sólo con URLs válidas; sin URLs no aparecen', () => {
    const withApps = renderSignature('cleverty', {
      ...base,
      assetBase: 'https://cdn.test',
      appStoreUrl: 'https://apps.apple.com/app',
      googlePlayUrl: 'https://play.google.com/app',
    });
    expect(withApps).toContain('/sig-icons/badge-apple.png');
    expect(withApps).toContain('/sig-icons/badge-googleplay.png');
    expect(withApps).toContain('App Store');
    expect(withApps).toContain('Google Play');
    // esquema peligroso → el badge no se renderiza (safeUrl)
    const evil = renderSignature('cleverty', {
      ...base,
      assetBase: 'https://cdn.test',
      appStoreUrl: 'javascript:alert(1)',
    });
    expect(evil).not.toContain('javascript:');
    expect(evil).not.toContain('badge-apple.png'); // safeUrl rechazó → sin badge
  });

  it('catálogo tiene los 10 diseños incl. banner/ejecutiva/compacta; el banner mantiene su banda de acento', () => {
    for (const id of ['banner', 'ejecutiva', 'compacta']) {
      expect(SIGNATURE_TEMPLATE_IDS).toContain(id);
    }
    // El banner usa una banda con background-color de acento → debe sobrevivir sanitizeEmailHtml.
    const html = renderSignature('banner', { ...base, accentColor: '#2563ff' });
    expect(sanitizeEmailHtml(html)).toContain('background-color:#2563ff');
    expect(html).not.toContain('overflow:hidden'); // estilo muerto (lo descarta el sanitizer) — removido
    // La regla de acento de ejecutiva (border-top) sobrevive el sanitizer.
    const ej = renderSignature('ejecutiva', { ...base, accentColor: '#2563ff' });
    expect(sanitizeEmailHtml(ej)).toContain('border-top:2px solid #2563ff');
    // compacta rinde el nombre y la empresa
    const c = renderSignature('compacta', base);
    expect(c).toContain('Ana Pérez');
    expect(c).toContain('Aulion');
  });

  it('cleverty: badge parcial — solo App Store válido (Google Play con esquema malo) → solo el válido', () => {
    const html = renderSignature('cleverty', {
      ...base,
      assetBase: 'https://cdn.test',
      appStoreUrl: 'https://apps.apple.com/app',
      googlePlayUrl: 'javascript:alert(1)',
    });
    expect(html).toContain('/sig-icons/badge-apple.png');
    expect(html).not.toContain('/sig-icons/badge-googleplay.png'); // safeUrl rechazó el malo
    expect(html).not.toContain('javascript:');
    // Con badges presentes, el HTML sobrevive el sanitizer intacto en los enlaces válidos.
    expect(sanitizeEmailHtml(html)).toContain('App Store');
  });

  it('cleverty está en el catálogo y rinde con las 2 iniciales', () => {
    expect(SIGNATURE_TEMPLATE_IDS).toContain('cleverty');
    const html = renderSignature('cleverty', { ...base, photoUrl: undefined });
    expect(html).toContain('>AP<');
    expect(sanitizeEmailHtml(html).length).toBeGreaterThan(50);
  });

  it('cleverty: el anillo del avatar SÍ sobrevive al sanitizer (background-color sólido, sin gradiente muerto)', () => {
    const html = renderSignature('cleverty', { ...base, accentColor: '#2563ff' });
    // No emitimos CSS que el sanitizer descarta (honestidad): sin background-image/linear-gradient.
    expect(html).not.toContain('linear-gradient');
    // El anillo (background-color de acento) permanece tras sanitizeEmailHtml → se ve en el email real.
    expect(sanitizeEmailHtml(html)).toContain('background-color:#2563ff');
  });

  it('corporativa: el tagline se muestra tanto con logo como sin logo (no se cae)', () => {
    // con logo (base tiene logoUrl) → tagline bajo el logo
    const withLogo = renderSignature('corporativa', { ...base, assetBase: 'https://cdn.test' });
    expect(withLogo).toContain('Tu correo, tu marca');
    // sin logo → tagline en el letterhead de texto, y companyName NO duplicado
    const noLogo = renderSignature('corporativa', { ...base, logoUrl: undefined });
    expect(noLogo).toContain('Tu correo, tu marca');
    expect((noLogo.match(/Aulion/g) ?? []).length).toBe(1); // empresa una sola vez
  });

  it('redes: github/whatsapp/website se renderizan si están presentes', () => {
    const html = renderSignature('clasica', {
      ...base,
      assetBase: 'https://cdn.test',
      socialLinks: {
        github: 'https://github.com/acme',
        whatsapp: 'https://wa.me/569',
        website: 'https://acme.io',
      },
    });
    expect(html).toContain('/sig-icons/social-github.png');
    expect(html).toContain('/sig-icons/social-whatsapp.png');
    expect(html).toContain('/sig-icons/social-web.png');
  });

  it('logoWidthPx no-numérico (llamada fuera de Zod) → ningún template filtra la inyección; todo width es numérico', () => {
    const evil = {
      ...base,
      // @ts-expect-error — simula una llamada directa con un valor runtime inválido
      logoWidthPx: '130" onerror="alert(1)',
    } as SignatureContext;
    for (const t of SIGNATURE_TEMPLATES) {
      const html = renderSignature(t.id, evil);
      expect(html, `${t.id}: onerror`).not.toContain('onerror');
      expect(html, `${t.id}: pxpx`).not.toContain('pxpx');
      expect(html, `${t.id}: no rompe atributo`).not.toContain('130"');
      // Cada `width:<n>px` que se emita es un entero limpio (pxWidth lo garantiza).
      for (const m of html.matchAll(/width:([^;"]*)px/g)) {
        expect(m[1], `${t.id}: width numérico`).toMatch(/^\d+$/);
      }
    }
  });
});
