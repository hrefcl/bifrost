import { describe, it, expect } from 'vitest';
import { meetSlugFromInput } from '../meet.js';

describe('meetSlugFromInput', () => {
  it('extrae el slug de un link completo', () => {
    expect(meetSlugFromInput('https://webmail.aulion.app/meet/X6RfPFJVPO6NL6MbMlVKJg')).toBe(
      'X6RfPFJVPO6NL6MbMlVKJg'
    );
  });
  it('extrae el slug de un path relativo', () => {
    expect(meetSlugFromInput('/meet/abc-123_XY')).toBe('abc-123_XY');
  });
  it('ignora query/fragment tras el slug', () => {
    expect(meetSlugFromInput('https://x/meet/slugcode12?foo=1#z')).toBe('slugcode12');
  });
  it('acepta un código pelado', () => {
    expect(meetSlugFromInput('  X6RfPFJVPO6NL6MbMlVKJg  ')).toBe('X6RfPFJVPO6NL6MbMlVKJg');
  });
  it('rechaza slugs demasiado cortos (backend exige {8,64})', () => {
    expect(meetSlugFromInput('slug99')).toBe(''); // 6 chars
    expect(meetSlugFromInput('/meet/abc')).toBe(''); // 3 chars
    expect(meetSlugFromInput('a'.repeat(65))).toBe(''); // demasiado largo
  });
  it('devuelve "" para vacío o entradas inválidas', () => {
    expect(meetSlugFromInput('')).toBe('');
    expect(meetSlugFromInput('   ')).toBe('');
    expect(meetSlugFromInput('no es un codigo con espacios')).toBe('');
    expect(meetSlugFromInput('https://webmail.aulion.app/inbox')).toBe('');
  });
});
