import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { deriveSesSmtpPassword, sesSmtpHost } from '../aws/ses-smtp.js';

// Reimplementación INDEPENDIENTE del algoritmo (reduce sobre la cadena, estructura distinta a la del
// módulo que usa pasos explícitos). Si ambas coinciden, un error de transcripción en una no pasa.
function reference(secret: string, region: string): string {
  const steps = ['11111111', region, 'ses', 'aws4_request', 'SendRawEmail'];
  const sig = steps.reduce(
    (k: Buffer, d) => createHmac('sha256', k).update(d, 'utf8').digest(),
    Buffer.from(`AWS4${secret}`, 'utf8')
  );
  return Buffer.concat([Buffer.from([0x04]), sig]).toString('base64');
}

describe('deriveSesSmtpPassword (SecretAccessKey → password SMTP de SES)', () => {
  const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'; // clave de ejemplo de la doc de AWS

  it('coincide con una reimplementación independiente del algoritmo', () => {
    for (const region of ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-southeast-2']) {
      expect(deriveSesSmtpPassword(SECRET, region)).toBe(reference(SECRET, region));
    }
  });

  it('estructura correcta: base64 que decodifica a 33 bytes con byte de versión 0x04', () => {
    const buf = Buffer.from(deriveSesSmtpPassword(SECRET, 'us-east-1'), 'base64');
    expect(buf.length).toBe(33); // 1 byte de versión + 32 de HMAC-SHA256
    expect(buf[0]).toBe(0x04); // versión del esquema de password SMTP de SES
  });

  it('es determinista y depende de la región (el endpoint SMTP es por región)', () => {
    expect(deriveSesSmtpPassword(SECRET, 'us-east-1')).toBe(
      deriveSesSmtpPassword(SECRET, 'us-east-1')
    );
    expect(deriveSesSmtpPassword(SECRET, 'us-east-1')).not.toBe(
      deriveSesSmtpPassword(SECRET, 'eu-west-1')
    );
  });

  it('pin de regresión (cualquier cambio en el algoritmo rompe esto a propósito)', () => {
    // Generados por la reimplementación independiente; congelan el contrato del algoritmo.
    expect(deriveSesSmtpPassword(SECRET, 'us-east-1')).toBe(
      'BLBM/9hSUELfq8Gw+rU1YcBjkOxGbhT2XG763xVLGWL9'
    );
    expect(deriveSesSmtpPassword(SECRET, 'eu-west-1')).toBe(
      'BMW5RDrXmmVs0lV7GpI4oLkHXpZ4stDsk6q91z1g38Pk'
    );
  });

  it('rechaza inputs vacíos (no derivar silenciosamente un password inválido)', () => {
    expect(() => deriveSesSmtpPassword('', 'us-east-1')).toThrow(/secretAccessKey/);
    expect(() => deriveSesSmtpPassword(SECRET, '')).toThrow(/region/);
  });
});

describe('sesSmtpHost', () => {
  it('arma el host SMTP por región', () => {
    expect(sesSmtpHost('us-east-1')).toBe('email-smtp.us-east-1.amazonaws.com');
    expect(sesSmtpHost('eu-west-1')).toBe('email-smtp.eu-west-1.amazonaws.com');
  });
  it('rechaza región vacía', () => {
    expect(() => sesSmtpHost('')).toThrow(/region/);
  });
});
