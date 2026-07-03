import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Forzamos que el RENDER lance (falla realista: bug de template, dependencia caída). `minimalPlainSignature`
// se mantiene REAL (importOriginal) para poder verificar el fallback. Prueba la garantía central del
// send-hook: FAIL-OPEN — buildUserSignature NUNCA propaga y no bloquea el envío (review A, hueco 🔴 fail-open).
vi.mock('../../lib/signature-templates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/signature-templates.js')>();
  return {
    ...actual,
    renderSignature: () => {
      throw new Error('boom render');
    },
  };
});

import { setupTestDb, teardownTestDb, resetState } from '../../../test/integration-helper.js';
import { User } from '../../models/User.js';
import { setBranding } from '../branding.js';
import { setSignaturePolicy } from '../signature-policy.js';
import { buildUserSignature, type SignatureUser } from '../user-signature.js';

const BASE = 'https://mail.example.com';

async function makeUser(): Promise<SignatureUser> {
  const u = await User.create({
    primaryEmail: 'ana@aulion.app',
    displayName: 'Ana Pérez',
    preferences: { autoIncludeSignature: true, signature: { source: 'template' } },
  });
  return User.findById(u._id).lean() as unknown as SignatureUser;
}

describe('buildUserSignature — FAIL-OPEN (el render lanza)', () => {
  beforeAll(async () => await setupTestDb());
  afterAll(async () => await teardownTestDb());
  beforeEach(async () => await resetState());

  it('con enforceSignature: NO lanza y cae a firma mínima en texto plano', async () => {
    await setBranding({ companyName: 'Aulion' }, 'admin');
    await setSignaturePolicy({ enforceSignature: true });
    const user = await makeUser();

    const res = await buildUserSignature(user, BASE); // no debe rechazar/lanzar
    expect(res.include).toBe(true);
    expect(res.html).toContain('Ana Pérez'); // minimalPlainSignature (real)
    expect(res.html).not.toContain('boom'); // el error no se filtra al HTML
    expect(res.html).not.toContain('<script>');
  });

  it('sin enforceSignature: NO lanza y devuelve sin firma (no bloquea el envío)', async () => {
    await setBranding({ companyName: 'Aulion' }, 'admin');
    await setSignaturePolicy({ enforceSignature: false });
    const user = await makeUser();

    const res = await buildUserSignature(user, BASE);
    expect(res.include).toBe(false);
    expect(res.html).toBe('');
  });
});
