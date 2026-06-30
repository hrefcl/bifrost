import { describe, it, expect } from 'vitest';
import { renderComplianceMarkdown, PIPELINE_VERSION } from '../complianceMarkdown.js';

describe('complianceMarkdown pipeline', () => {
  it('renderiza markdown básico a HTML', () => {
    const { html, pipelineVersion } = renderComplianceMarkdown(
      '# Título\n\nUn **párrafo** con _énfasis_.'
    );
    expect(html).toContain('<h1>Título</h1>');
    expect(html).toContain('<strong>párrafo</strong>');
    expect(html).toContain('<em>énfasis</em>');
    expect(pipelineVersion).toBe(PIPELINE_VERSION);
  });

  it('renderiza listas y tablas', () => {
    const { html } = renderComplianceMarkdown('- a\n- b\n\n| h |\n|---|\n| c |');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<table>');
  });

  it('escapa HTML crudo embebido (html:false)', () => {
    const { html } = renderComplianceMarkdown('Texto <script>alert(1)</script> y <b>bold-html</b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('alert(1)'); // queda como texto escapado, inerte
  });

  it('neutraliza <img onerror> e imágenes markdown (sin elemento vivo)', () => {
    const { html } = renderComplianceMarkdown(
      '![x](https://e.test/a.png "t")\n\n<img src=x onerror=alert(1)>'
    );
    // Ni imagen markdown ni <img> crudo sobreviven como elemento; no hay atributo on* vivo.
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i);
  });

  it('bloquea enlaces javascript: y data: (no se crea <a> ejecutable)', () => {
    const { html } = renderComplianceMarkdown(
      '[click](javascript:alert(1)) y [d](data:text/html,x)'
    );
    expect(html).not.toMatch(/<a[^>]+href="javascript:/i);
    expect(html).not.toMatch(/<a[^>]+href="data:/i);
  });

  it('permite enlaces http/https/mailto con rel seguro', () => {
    const { html } = renderComplianceMarkdown(
      '[sitio](https://example.com) [mail](mailto:a@b.com)'
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('href="mailto:a@b.com"');
  });

  it('descarta iframe/style/on* handlers', () => {
    const { html } = renderComplianceMarkdown(
      '<iframe src=evil></iframe>\n\n<style>body{}</style>'
    );
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<style');
  });

  it('maneja entrada vacía sin romper', () => {
    expect(renderComplianceMarkdown('').html).toBe('');
  });
});
