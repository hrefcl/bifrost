import { describe, it, expect } from 'vitest';
import { needsProfileCompletion } from '../profile.js';

describe('needsProfileCompletion', () => {
  it('nombre autogenerado (= prefijo del email) → incompleto', () => {
    expect(
      needsProfileCompletion({
        displayName: 'f.arenas',
        primaryEmail: 'f.arenas@cleverty.info',
        phone: '+56 9 1111 1111',
      })
    ).toBe(true);
  });

  it('nombre autogenerado, distinto case → incompleto (comparación case-insensitive)', () => {
    expect(
      needsProfileCompletion({
        displayName: 'F.Arenas',
        primaryEmail: 'f.arenas@x.com',
        phone: '123456',
      })
    ).toBe(true);
  });

  it('nombre vacío → incompleto', () => {
    expect(
      needsProfileCompletion({ displayName: '   ', primaryEmail: 'a@x.com', phone: '123456' })
    ).toBe(true);
  });

  it('nombre real SIN teléfono → COMPLETO (el gate NO dispara por teléfono, decisión de producto)', () => {
    expect(
      needsProfileCompletion({ displayName: 'Francisco Arenas', primaryEmail: 'f.arenas@x.com' })
    ).toBe(false);
    expect(
      needsProfileCompletion({
        displayName: 'Francisco Arenas',
        primaryEmail: 'f.arenas@x.com',
        phone: '  ',
      })
    ).toBe(false);
  });

  it('nombre real + teléfono → COMPLETO', () => {
    expect(
      needsProfileCompletion({
        displayName: 'Francisco Arenas',
        primaryEmail: 'f.arenas@cleverty.info',
        phone: '+56 9 9689 5893',
      })
    ).toBe(false);
  });

  it('nombre real que casualmente contiene el prefijo pero no es igual → completo', () => {
    expect(
      needsProfileCompletion({
        displayName: 'Arenas Ampuero',
        primaryEmail: 'arenas@x.com',
        phone: '123456',
      })
    ).toBe(false);
  });
});
