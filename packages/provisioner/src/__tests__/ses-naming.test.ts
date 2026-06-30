import { describe, it, expect } from 'vitest';
import {
  domainSlug,
  sesParamName,
  sesUserName,
  sesConfigSetName,
  SES_POLICY_NAME,
} from '../ses/naming.js';

describe('nombres SES determinísticos', () => {
  it('domainSlug normaliza el dominio', () => {
    expect(domainSlug('Acme.COM')).toBe('acme-com');
    expect(domainSlug('mi_empresa.io')).toBe('mi-empresa-io');
    expect(domainSlug('a..b.com')).toBe('a-b-com');
  });

  it('todos los nombres derivan del mismo slug (CFN/orquestador/box deben coincidir)', () => {
    const d = 'acme.com';
    expect(sesParamName(d)).toBe('/bifrost/acme-com/ses-smtp');
    expect(sesUserName(d)).toBe('bifrost-ses-acme-com');
    expect(sesConfigSetName(d)).toBe('bifrost-acme-com');
    expect(SES_POLICY_NAME).toBe('bifrost-ses-send');
  });

  it('el nombre del parámetro empieza con / (ARN válido :parameter/bifrost/...)', () => {
    expect(sesParamName('x.com').startsWith('/')).toBe(true);
  });

  it('estable: el mismo dominio siempre da el mismo nombre', () => {
    expect(sesParamName('acme.com')).toBe(sesParamName('ACME.com'));
    expect(sesUserName('acme.com')).toBe(sesUserName('acme.com'));
  });
});
