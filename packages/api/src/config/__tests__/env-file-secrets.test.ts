import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFileSecrets } from '../env.js';

describe('resolveFileSecrets (docker secrets *_FILE)', () => {
  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_FILE;
  });

  it('carga el secreto desde <VAR>_FILE (con trim) si <VAR> está vacío', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'));
    const f = join(dir, 'jwt');
    writeFileSync(f, '  supersecretjwt  \n');
    delete process.env.JWT_SECRET;
    process.env.JWT_SECRET_FILE = f;
    resolveFileSecrets();
    expect(process.env.JWT_SECRET).toBe('supersecretjwt');
  });

  it('NO pisa <VAR> si ya viene seteado directamente', () => {
    process.env.JWT_SECRET = 'already-set';
    process.env.JWT_SECRET_FILE = '/no/existe';
    resolveFileSecrets();
    expect(process.env.JWT_SECRET).toBe('already-set');
  });

  it('lanza si el archivo apuntado por <VAR>_FILE no se puede leer', () => {
    delete process.env.JWT_SECRET;
    process.env.JWT_SECRET_FILE = '/no/existe/secreto';
    expect(() => resolveFileSecrets()).toThrow(/JWT_SECRET_FILE/);
  });
});
