import { describe, it, expect } from 'vitest';
import { validateDomain, mailHostname } from '../domain.js';
import { validateBucketName } from '../s3-naming.js';
import {
  recommendInstance,
  recommendInstanceFor,
  describeInstanceChoice,
  ALLINONE_CATALOG,
  archForInstanceType,
  enforceMeetInstanceFloor,
  MEET_INSTANCE_FLOOR,
} from '../catalog/instance-types.js';

describe('validateDomain', () => {
  it('acepta FQDNs válidos', () => {
    for (const d of ['example.com', 'mail.empresa.io', 'a.b.c.dev', 'EMPRESA.COM']) {
      expect(validateDomain(d), d).toBe(true);
    }
  });
  it('rechaza inválidos', () => {
    for (const d of [
      '',
      'localhost',
      'no_underscore.com',
      '-bad.com',
      'bad-.com',
      'a..b.com',
      'sin-tld',
    ]) {
      expect(validateDomain(d), d).toBe(false);
    }
  });
  it('mailHostname antepone mail. en minúsculas', () => {
    expect(mailHostname('Empresa.COM')).toBe('mail.empresa.com');
  });
});

describe('validateBucketName', () => {
  it('acepta nombres válidos', () => {
    expect(validateBucketName('bifrost-mail-data').valid).toBe(true);
    expect(validateBucketName('my.bucket.123').valid).toBe(true);
  });
  it('rechaza inválidos con motivo', () => {
    expect(validateBucketName('ab').valid).toBe(false); // corto
    expect(validateBucketName('UPPER').valid).toBe(false); // mayúsculas
    expect(validateBucketName('a..b').valid).toBe(false); // puntos consecutivos
    expect(validateBucketName('192.168.0.1').valid).toBe(false); // IP
    expect(validateBucketName('-leading').valid).toBe(false); // empieza con guion
    expect(validateBucketName('xn--punycode').valid).toBe(false); // prefijo reservado
    expect(validateBucketName('thing-s3alias').valid).toBe(false); // sufijo reservado
  });
});

describe('catálogo de instancias', () => {
  it('el recomendado existe en el catálogo y tiene ≥4GB', () => {
    const rec = recommendInstance();
    expect(ALLINONE_CATALOG).toContainEqual(rec);
    expect(rec.memGiB).toBeGreaterThanOrEqual(4);
  });
  it('ningún tipo del catálogo all-in-one baja de 4GB', () => {
    for (const i of ALLINONE_CATALOG) expect(i.memGiB).toBeGreaterThanOrEqual(4);
  });
  it('el catálogo default es Graviton (arm64, más barato)', () => {
    for (const i of ALLINONE_CATALOG) expect(i.arch).toBe('arm64');
    expect(recommendInstance().type).toMatch(/^t4g\./);
  });
  it('archForInstanceType deriva la arch (Graviton lleva sufijo g)', () => {
    expect(archForInstanceType('t4g.large')).toBe('arm64');
    expect(archForInstanceType('m6g.xlarge')).toBe('arm64');
    expect(archForInstanceType('c7gd.medium')).toBe('arm64');
    expect(archForInstanceType('t3.large')).toBe('amd64');
    expect(archForInstanceType('m5.large')).toBe('amd64');
    expect(archForInstanceType('c6i.large')).toBe('amd64');
  });
  it('incluye una instancia grande (t4g.2xlarge, ~500 buzones) para empresas grandes', () => {
    const big = ALLINONE_CATALOG.find((i) => i.type === 't4g.2xlarge');
    expect(big).toBeDefined();
    expect(big?.maxMailboxes).toBeGreaterThanOrEqual(500);
    expect(big?.meetConcurrent).toBeGreaterThan(0); // apto para Meet
  });
  it('los campos de capacidad son coherentes (crecen con el tamaño; medium no apto para Meet)', () => {
    const sorted = [...ALLINONE_CATALOG].sort((a, b) => a.memGiB - b.memGiB);
    for (let k = 1; k < sorted.length; k++) {
      expect(sorted[k].maxMailboxes).toBeGreaterThanOrEqual(sorted[k - 1].maxMailboxes);
    }
    // <8 GiB → no apto para Meet self-hosted (meetConcurrent 0).
    for (const i of ALLINONE_CATALOG) {
      if (i.memGiB < 8) expect(i.meetConcurrent).toBe(0);
      else expect(i.meetConcurrent).toBeGreaterThan(0);
    }
  });
});

describe('recommendInstanceFor (dimensiona por buzones + Meet)', () => {
  it('elige la MÁS CHICA que cubre los buzones (solo-correo)', () => {
    expect(recommendInstanceFor(10, false).instance.type).toBe('t4g.medium'); // ≤15
    expect(recommendInstanceFor(50, false).instance.type).toBe('t4g.large'); // ≤50
    expect(recommendInstanceFor(120, false).instance.type).toBe('t4g.xlarge'); // ≤150
    expect(recommendInstanceFor(400, false).instance.type).toBe('t4g.2xlarge'); // ≤500
  });
  it('con Meet bundled: descarta la medium (<8 GiB) y halva la capacidad de buzones', () => {
    // 50 buzones + Meet: la large cómoda es ~25 → no alcanza → sube a xlarge (~75) o 2xlarge.
    const r = recommendInstanceFor(50, true);
    expect(r.instance.meetConcurrent).toBeGreaterThan(0);
    expect(r.instance.memGiB).toBeGreaterThanOrEqual(8);
    // 10 buzones + Meet entran en la large (cap ~25).
    expect(recommendInstanceFor(10, true).instance.type).toBe('t4g.large');
  });
  it('si supera el catálogo, devuelve la más grande con exceedsCatalog=true', () => {
    const r = recommendInstanceFor(5000, false);
    expect(r.instance.type).toBe('t4g.2xlarge');
    expect(r.exceedsCatalog).toBe(true);
  });
});

describe('describeInstanceChoice (etiqueta del menú)', () => {
  it('muestra specs, costo y buzones; con Meet suma participantes', () => {
    const large = ALLINONE_CATALOG.find((i) => i.type === 't4g.large');
    if (!large) throw new Error('falta t4g.large');
    const plain = describeInstanceChoice(large, false);
    expect(plain).toContain('t4g.large');
    expect(plain).toContain('8 GiB');
    expect(plain).toContain('$49/mes');
    expect(plain).toContain('50 buzones');
    const withMeet = describeInstanceChoice(large, true);
    expect(withMeet).toContain('en llamada'); // participantes de Meet
    expect(withMeet).toContain('25 buzones'); // capacidad halvada con Meet
  });
});

describe('enforceMeetInstanceFloor (piso ≥8 GiB con Meet, F3.5)', () => {
  it('sube un tipo de catálogo con <8 GiB al piso (t4g.medium → t4g.large)', () => {
    const r = enforceMeetInstanceFloor('t4g.medium');
    expect(r).toEqual({ type: MEET_INSTANCE_FLOOR, bumped: true, unknownBelowFloor: false });
    expect(r.type).toBe('t4g.large');
  });
  it('respeta un tipo de catálogo con ≥8 GiB (no toca large/xlarge)', () => {
    expect(enforceMeetInstanceFloor('t4g.large')).toEqual({
      type: 't4g.large',
      bumped: false,
      unknownBelowFloor: false,
    });
    expect(enforceMeetInstanceFloor('t4g.xlarge').bumped).toBe(false);
  });
  it('un tipo FUERA del catálogo se respeta pero marca unknownBelowFloor (el wizard avisa)', () => {
    const r = enforceMeetInstanceFloor('m7g.large');
    expect(r).toEqual({ type: 'm7g.large', bumped: false, unknownBelowFloor: true });
  });
  it('es idempotente (aplicar dos veces no cambia el resultado)', () => {
    const once = enforceMeetInstanceFloor('t4g.medium').type;
    expect(enforceMeetInstanceFloor(once).type).toBe(once);
  });
});
