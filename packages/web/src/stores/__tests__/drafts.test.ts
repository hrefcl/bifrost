import { describe, it, expect } from 'vitest';
import { parseAddresses } from '../drafts';

describe('parseAddresses', () => {
  it('emails simples separados por coma', () => {
    expect(parseAddresses('a@x.com, b@y.com')).toEqual([
      { address: 'a@x.com' },
      { address: 'b@y.com' },
    ]);
  });

  it('extrae name + address de "Nombre <email>"', () => {
    expect(parseAddresses('Ana <ana@x.com>')).toEqual([{ address: 'ana@x.com', name: 'Ana' }]);
  });

  it('NO se rompe con comas dentro de comillas o ángulos', () => {
    const r = parseAddresses('"Pérez, Ana" <ana@x.com>, bob@y.com');
    expect(r).toEqual([{ address: 'ana@x.com', name: 'Pérez, Ana' }, { address: 'bob@y.com' }]);
  });

  it('mezcla bare + named; ignora vacíos y espacios', () => {
    expect(parseAddresses('  , a@x.com ,Bob <bob@y.com>,')).toEqual([
      { address: 'a@x.com' },
      { address: 'bob@y.com', name: 'Bob' },
    ]);
  });

  it('lista vacía → []', () => {
    expect(parseAddresses('')).toEqual([]);
    expect(parseAddresses('   ')).toEqual([]);
  });
});
