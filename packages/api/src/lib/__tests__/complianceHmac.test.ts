import { describe, it, expect, beforeEach } from 'vitest';
import {
  canonicalEvidence,
  signEvidence,
  verifyEvidence,
  computeContentHash,
  currentKeyId,
  type EvidenceFields,
} from '../complianceHmac.js';

const baseFields: EvidenceFields = {
  tenantId: 'default',
  userId: '507f1f77bcf86cd799439011',
  documentKey: 'terms-of-service',
  versionId: '507f191e810c19729de860ea',
  version: 3,
  contentHash: 'abc123',
  acceptedAt: '2026-06-29T12:00:00.000Z',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (X11; Linux) | weird; chars',
  method: 'scroll_confirmed',
  locale: 'es',
};

describe('complianceHmac', () => {
  beforeEach(() => {
    process.env.COMPLIANCE_HMAC_SECRET = 'test-secret-at-least-32-characters-long-xx';
    delete process.env.COMPLIANCE_HMAC_RETIRED_KEYS;
  });

  it('canonical es determinista y no ambiguo (length-prefix evita colisión con delimitadores)', () => {
    const a = canonicalEvidence(baseFields);
    const b = canonicalEvidence({ ...baseFields });
    expect(a).toBe(b);
    // length-prefix: el `|` dentro de userAgent no puede confundirse con el separador.
    expect(a).toContain(`${String(baseFields.userAgent.length)}:${baseFields.userAgent}`);
  });

  it('dos registros distintos NO colisionan aunque muevan un delimitador entre campos', () => {
    const f1 = { ...baseFields, ip: 'a|b', userAgent: 'c' };
    const f2 = { ...baseFields, ip: 'a', userAgent: 'b|c' };
    expect(canonicalEvidence(f1)).not.toBe(canonicalEvidence(f2));
  });

  it('sign + verify round-trip válido', () => {
    const { hmacKeyId, evidenceHmac } = signEvidence(baseFields);
    expect(hmacKeyId).toHaveLength(16);
    expect(verifyEvidence(baseFields, hmacKeyId, evidenceHmac)).toBe(true);
  });

  it('detecta manipulación de cualquier campo', () => {
    const { hmacKeyId, evidenceHmac } = signEvidence(baseFields);
    expect(verifyEvidence({ ...baseFields, ip: '10.0.0.1' }, hmacKeyId, evidenceHmac)).toBe(false);
    expect(verifyEvidence({ ...baseFields, version: 4 }, hmacKeyId, evidenceHmac)).toBe(false);
    expect(verifyEvidence({ ...baseFields, locale: 'en' }, hmacKeyId, evidenceHmac)).toBe(false);
  });

  it('verificación falla con keyId desconocido (clave no en el registro)', () => {
    const { evidenceHmac } = signEvidence(baseFields);
    expect(verifyEvidence(baseFields, 'deadbeefdeadbeef', evidenceHmac)).toBe(false);
  });

  it('rotación: una clave retirada sigue verificando evidencia histórica', () => {
    // Firma con el secreto "viejo".
    process.env.COMPLIANCE_HMAC_SECRET = 'old-secret-at-least-32-characters-long-xxx';
    const oldKeyId = currentKeyId();
    const { hmacKeyId, evidenceHmac } = signEvidence(baseFields);
    expect(hmacKeyId).toBe(oldKeyId);

    // Rota el secreto actual y archiva el viejo en el registro de retiradas.
    process.env.COMPLIANCE_HMAC_SECRET = 'new-secret-at-least-32-characters-long-yyy';
    process.env.COMPLIANCE_HMAC_RETIRED_KEYS = JSON.stringify({
      [oldKeyId]: 'old-secret-at-least-32-characters-long-xxx',
    });

    // La evidencia histórica (firmada con el viejo) sigue verificando vía el registro.
    expect(currentKeyId()).not.toBe(oldKeyId);
    expect(verifyEvidence(baseFields, hmacKeyId, evidenceHmac)).toBe(true);
  });

  it('computeContentHash es estable ante el ORDEN de las locales', () => {
    const h1 = computeContentHash([
      { locale: 'es', title: 'T', bodyMarkdown: 'A' },
      { locale: 'en', title: 'T', bodyMarkdown: 'B' },
    ]);
    const h2 = computeContentHash([
      { locale: 'en', title: 'T', bodyMarkdown: 'B' },
      { locale: 'es', title: 'T', bodyMarkdown: 'A' },
    ]);
    expect(h1).toBe(h2);
  });

  it('computeContentHash cambia si cambia el texto fuente', () => {
    const h1 = computeContentHash([{ locale: 'es', title: 'T', bodyMarkdown: 'A' }]);
    const h2 = computeContentHash([{ locale: 'es', title: 'T', bodyMarkdown: 'A2' }]);
    expect(h1).not.toBe(h2);
  });
});
