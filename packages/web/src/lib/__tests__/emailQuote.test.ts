// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { splitEmailQuote } from '../emailQuote';

describe('splitEmailQuote', () => {
  it('Gmail: separa el contenido nuevo de la cita (gmail_quote)', () => {
    const html =
      '<div dir="ltr">Mi respuesta</div>' +
      '<div class="gmail_quote"><div class="gmail_attr">El lun escribió:</div>' +
      '<blockquote class="gmail_quote">texto previo</blockquote></div>';
    const { main, quoted } = splitEmailQuote(html);
    expect(main).toContain('Mi respuesta');
    expect(main).not.toContain('texto previo');
    expect(quoted).toContain('texto previo');
    expect(quoted).toContain('El lun escribió');
  });

  it('Apple Mail: blockquote type=cite va a la cita', () => {
    const html = '<div>Hola</div><blockquote type="cite">lo anterior</blockquote>';
    const { main, quoted } = splitEmailQuote(html);
    expect(main).toContain('Hola');
    expect(quoted).toContain('lo anterior');
  });

  it('NO colapsa un <blockquote> decorativo sin marca de cita (anti falso-positivo)', () => {
    // Un pull-quote de newsletter: blockquote SIN type="cite" ni clase de cita → NO es una respuesta.
    const html =
      '<p>Mira esta cita inspiradora:</p><blockquote>El futuro es hoy</blockquote><p>Saludos</p>';
    const { main, quoted } = splitEmailQuote(html);
    expect(quoted).toBe(''); // no se esconde nada
    expect(main).toContain('El futuro es hoy');
    expect(main).toContain('Saludos');
  });

  it('sin cita → todo es contenido nuevo, quoted vacío', () => {
    const html = '<p>Un correo normal sin citas</p>';
    const { main, quoted } = splitEmailQuote(html);
    expect(main).toBe(html);
    expect(quoted).toBe('');
  });

  it('todo el cuerpo es cita (forward) → no se colapsa (quoted vacío)', () => {
    const html = '<blockquote type="cite">solo contenido citado</blockquote>';
    const { quoted } = splitEmailQuote(html);
    expect(quoted).toBe(''); // no hay contenido nuevo que mostrar aparte
  });

  it('HTML inválido no rompe (devuelve el original como main)', () => {
    const html = '<div>texto<';
    const { main } = splitEmailQuote(html);
    expect(main).toContain('texto');
  });
});
