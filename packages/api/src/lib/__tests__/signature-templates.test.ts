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
    const html = renderSignature('photo-round', ctx);
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
    const html = renderSignature('photo-round', evil);
    expect(html).not.toContain('javascript:');
    // Con photoUrl válida (interna) sí aparece el <img>.
    const ok = renderSignature('photo-round', {
      ...base,
      photoUrl: '/api/signature-images/0123456789abcdef01234567',
    });
    expect(ok).toContain('<img');
  });

  it('accentColor no-hex se ignora (no rompe el atributo style)', () => {
    const evil = { ...base, accentColor: 'red;position:absolute;left:0' };
    const html = renderSignature('vertical', evil);
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
});
