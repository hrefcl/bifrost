import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, randomToken } from '../crypto.js';

describe('crypto', () => {
  it('round-trips plaintext', () => {
    const plain = 'my-imap-password-123';
    const encrypted = encrypt(plain);
    expect(encrypted.ciphertext).not.toBe(plain);
    expect(encrypted.iv).toHaveLength(32);
    expect(encrypted.tag).toHaveLength(32);
    expect(decrypt(encrypted)).toBe(plain);
  });

  it('produces unique ciphertexts for the same plain', () => {
    const plain = 'same';
    const a = encrypt(plain);
    const b = encrypt(plain);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encrypt('secret');
    // Tamper DETERMINISTA: flip de bits del primer byte → SIEMPRE cambia el ciphertext (el
    // `slice(-2)+'ff'` previo era flaky: si los últimos 2 hex ya eran 'ff' no cambiaba nada
    // y el auth tag GCM seguía validando → falso fallo intermitente).
    const buf = Buffer.from(encrypted.ciphertext, 'hex');
    buf[0] ^= 0xff;
    encrypted.ciphertext = buf.toString('hex');
    expect(() => decrypt(encrypted)).toThrow();
  });

  it('generates random tokens', () => {
    const t1 = randomToken();
    const t2 = randomToken();
    expect(t1).not.toBe(t2);
    expect(Buffer.from(t1, 'hex')).toHaveLength(32);
  });

  // F3.2 — resolución lazy de la clave (fix H-CRYPTO-SETUP).
  it('lanza si ENCRYPTION_KEY está ausente (nunca cifra con clave por defecto)', () => {
    const original = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY/);
    } finally {
      process.env.ENCRYPTION_KEY = original;
    }
  });

  it('usa la clave actual de process.env en cada llamada (lazy)', () => {
    const original = process.env.ENCRYPTION_KEY;
    try {
      // Clave A: cifra
      process.env.ENCRYPTION_KEY = 'a'.repeat(64);
      const enc = encrypt('payload');
      expect(decrypt(enc)).toBe('payload');
      // Clave B distinta: el ciphertext de A ya no descifra (prueba que la clave
      // se resuelve por-llamada, no se fija al importar el módulo).
      process.env.ENCRYPTION_KEY = 'b'.repeat(64);
      expect(() => decrypt(enc)).toThrow();
    } finally {
      process.env.ENCRYPTION_KEY = original;
    }
  });
});
