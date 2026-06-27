import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml, plainTextFromHtml } from '../sanitizeHtml.js';

/**
 * Regresión de SEGURIDAD: sanitizeEmailHtml es el límite anti-XSS del webmail (su salida se
 * renderiza con v-html en el front). Estos tests fijan que TODO vector ejecutable se elimina y
 * que el contenido legítimo sobrevive. Un cambio en la config que reabra un vector debe romper acá.
 */
describe('sanitizeEmailHtml — defensa anti-XSS', () => {
  const strips = (html: string, needle: RegExp) => {
    const out = sanitizeEmailHtml(html);
    expect(out, `debería filtrar: ${html}`).not.toMatch(needle);
    return out;
  };

  it('elimina <script>', () => {
    strips('<p>hola</p><script>alert(1)</script>', /<script|alert\(1\)/i);
  });

  it('elimina handlers de eventos (onerror/onclick/onload)', () => {
    strips('<img src="https://x/y.png" onerror="alert(1)">', /onerror/i);
    strips('<div onclick="alert(1)">x</div>', /onclick/i);
    strips('<body onload="alert(1)">x</body>', /onload/i);
  });

  it('elimina URLs javascript: en href y src', () => {
    strips('<a href="javascript:alert(1)">x</a>', /javascript:/i);
    strips('<img src="javascript:alert(1)">', /javascript:/i);
    // Con espacios/mayúsculas/entidades, el esquema no permitido se descarta.
    strips('<a href="JaVaScRiPt:alert(1)">x</a>', /javascript:/i);
  });

  it('elimina URLs data: (data:text/html ejecutable)', () => {
    strips('<a href="data:text/html,<script>alert(1)</script>">x</a>', /data:text\/html/i);
    strips('<img src="data:text/html;base64,PHNjcmlwdD4=">', /data:text\/html/i);
  });

  it('elimina <iframe>, <object>, <embed>', () => {
    strips('<iframe src="https://evil"></iframe>', /<iframe/i);
    strips('<object data="https://evil"></object>', /<object/i);
    strips('<embed src="https://evil">', /<embed/i);
  });

  it('elimina <svg> (puede portar scripts)', () => {
    strips('<svg><script>alert(1)</script></svg>', /<svg|<script/i);
    strips('<svg onload="alert(1)"></svg>', /<svg|onload/i);
  });

  it('elimina <style> y atributos style inline (sin inyección de CSS)', () => {
    strips('<style>body{background:url(javascript:alert(1))}</style>', /<style|javascript:/i);
    strips('<p style="background:url(javascript:alert(1))">x</p>', /style=|javascript:/i);
  });

  it('elimina <form>/<input>/<base>/<meta>', () => {
    strips('<form action="https://evil"><input name="x"></form>', /<form|<input/i);
    strips('<base href="https://evil/">', /<base/i);
    strips('<meta http-equiv="refresh" content="0;url=https://evil">', /<meta/i);
  });

  it('preserva enlaces legítimos forzando rel=noopener noreferrer + target=_blank', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('preserva mailto: y formato básico (b/blockquote/h1/img https)', () => {
    expect(sanitizeEmailHtml('<a href="mailto:a@b.com">m</a>')).toContain('mailto:a@b.com');
    expect(sanitizeEmailHtml('<b>n</b>')).toContain('<b>n</b>');
    expect(sanitizeEmailHtml('<blockquote>q</blockquote>')).toContain('<blockquote>');
    expect(sanitizeEmailHtml('<h1>t</h1>')).toContain('<h1>');
    expect(sanitizeEmailHtml('<img src="https://x/y.png" alt="a">')).toContain(
      'src="https://x/y.png"'
    );
  });

  it('plainTextFromHtml descarta TODO tag (incluye los ejecutables)', () => {
    expect(plainTextFromHtml('<script>alert(1)</script><b>hola</b>')).toBe('hola');
    expect(plainTextFromHtml('<img src=x onerror=alert(1)>texto')).not.toMatch(/onerror|<img/i);
  });
});
