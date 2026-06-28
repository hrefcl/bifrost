import { describe, it, expect } from 'vitest';
import { escapeHtml, buildEmailPrintHtml } from '../print-email';

describe('escapeHtml', () => {
  it('escapa los metacaracteres HTML', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`a & b "c" 'd'`)).toBe('a &amp; b &quot;c&quot; &#39;d&#39;');
  });
});

describe('buildEmailPrintHtml', () => {
  const base = {
    subject: 'Hola',
    fromName: 'Ana',
    fromAddress: 'ana@test.com',
    toLabel: 'para mí',
    dateText: '13 jun 2026, 12:00',
  };

  it('escapa las cabeceras controladas por el usuario (anti-XSS en print)', () => {
    const html = buildEmailPrintHtml({
      ...base,
      subject: '<img src=x onerror=alert(1)>',
      fromName: '<b>spoof</b>',
      text: 'cuerpo',
    });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<b>spoof</b>');
    expect(html).toContain('&lt;b&gt;spoof&lt;/b&gt;');
  });

  it('usa el sanitizedHtml del backend tal cual para el cuerpo', () => {
    const html = buildEmailPrintHtml({
      ...base,
      sanitizedHtml: '<p>contenido <strong>seguro</strong></p>',
    });
    expect(html).toContain('<p>contenido <strong>seguro</strong></p>');
  });

  it('cae al text escapado en <pre> cuando no hay sanitizedHtml', () => {
    const html = buildEmailPrintHtml({ ...base, text: 'línea1\n<script>' });
    expect(html).toContain('<pre');
    expect(html).toContain('línea1\n&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('es un documento HTML completo con el asunto en el title', () => {
    const html = buildEmailPrintHtml({ ...base, text: 'x' });
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<title>Hola</title>');
  });
});
