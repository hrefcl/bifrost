import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, resetState } from '../../../test/integration-helper.js';
import { User } from '../../models/User.js';
import { setBranding } from '../branding.js';
import { setSignaturePolicy, SignaturePolicyError } from '../signature-policy.js';
import { buildUserSignature, type SignatureUser } from '../user-signature.js';

const BASE = 'https://mail.example.com';

async function makeUser(
  over: Partial<SignatureUser['preferences']> & Record<string, unknown> = {}
) {
  const { signature, defaultSignature, autoIncludeSignature, ...profile } = over;
  const u = await User.create({
    primaryEmail: 'ana@aulion.app',
    displayName: 'Ana Pérez',
    jobTitle: 'Gerente',
    ...profile,
    preferences: {
      autoIncludeSignature: autoIncludeSignature ?? true,
      defaultSignature,
      signature,
    },
  });
  return User.findById(u._id).lean() as unknown as SignatureUser;
}

describe('buildUserSignature (firmas F5) + signature-policy (F6)', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => await resetState());

  it('source template → rendiza el template con branding + datos del User', async () => {
    await setBranding({ companyName: 'Aulion', domainUrl: 'https://aulion.app' }, 'admin');
    const user = await makeUser({ signature: { source: 'template', templateId: 'clasica' } });
    const { html, include } = await buildUserSignature(user, BASE);
    expect(include).toBe(true);
    expect(html).toContain('Ana Pérez');
    expect(html).toContain('Aulion');
    expect(html).toContain('Gerente');
  });

  it('source custom → usa el defaultSignature (HTML pegado) saneado', async () => {
    const user = await makeUser({
      signature: { source: 'custom' },
      defaultSignature: '<p>Saludos <b>Ana</b></p><script>bad()</script>',
    });
    const { html } = await buildUserSignature(user, BASE);
    expect(html).toContain('<b>Ana</b>');
    expect(html).not.toContain('<script>');
  });

  it('legado (sin signature pref, con defaultSignature) → sigue usando el HTML legado', async () => {
    const user = await makeUser({ defaultSignature: '<p>Firma legada</p>' });
    const { html, include } = await buildUserSignature(user, BASE);
    expect(include).toBe(true);
    expect(html).toContain('Firma legada');
  });

  it('autoInclude=false y sin enforce → no incluye firma', async () => {
    const user = await makeUser({
      autoIncludeSignature: false,
      signature: { source: 'template', templateId: 'minimalista' },
    });
    const { include } = await buildUserSignature(user, BASE);
    expect(include).toBe(false);
  });

  it('enforceSignature=true → incluye firma aunque autoInclude=false', async () => {
    await setSignaturePolicy({ enforceSignature: true });
    const user = await makeUser({
      autoIncludeSignature: false,
      signature: { source: 'template', templateId: 'minimalista' },
    });
    const { html, include } = await buildUserSignature(user, BASE);
    expect(include).toBe(true);
    expect(html).toContain('Ana Pérez');
  });

  it('lockTemplate → usa el template forzado, ignorando la elección del usuario', async () => {
    await setSignaturePolicy({ allowedTemplateIds: ['minimalista'], lockTemplate: true });
    const user = await makeUser({ signature: { source: 'template', templateId: 'clasica' } });
    const { html } = await buildUserSignature(user, BASE);
    // 'minimalista' es un <div>, no la tabla del 'clasica'.
    expect(html).toContain('<div');
    expect(html).not.toContain('cellpadding');
  });

  it('setSignaturePolicy: invariante lockTemplate ⇒ ≥1 template válido (rechaza)', async () => {
    await expect(
      setSignaturePolicy({ lockTemplate: true, allowedTemplateIds: [] })
    ).rejects.toBeInstanceOf(SignaturePolicyError);
    // ids stale se filtran contra el catálogo.
    const p = await setSignaturePolicy({ allowedTemplateIds: ['bogus', 'minimalista'] });
    expect(p.allowedTemplateIds).toEqual(['minimalista']);
  });

  it('allowCustomHtml=false + source custom + enforce → cae al render de template (no HTML pegado)', async () => {
    await setSignaturePolicy({ allowCustomHtml: false, enforceSignature: true });
    const user = await makeUser({
      signature: { source: 'custom' },
      defaultSignature: '<p>PEGADO PROHIBIDO</p>',
    });
    const { html, include } = await buildUserSignature(user, BASE);
    expect(include).toBe(true);
    expect(html).not.toContain('PEGADO PROHIBIDO');
    expect(html).toContain('Ana Pérez');
  });
});
