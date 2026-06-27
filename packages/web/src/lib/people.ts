/** Helpers de presentación de personas: iniciales y color de avatar deterministas. */

// Paleta alineada con la maqueta (data.jsx): tonos saturados sobre texto blanco.
const PALETTE = [
  '#1b66ff',
  '#9333ea',
  '#0891b2',
  '#16a34a',
  '#ea580c',
  '#dc2626',
  '#db2777',
  '#ca8a04',
  '#0d9488',
  '#635bff',
];

/** Color estable para una persona: deriva un índice de la paleta desde su email/nombre. */
export function colorFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/** Iniciales (1–2 caracteres) a partir de un nombre; cae al email si no hay nombre. */
export function initialsFor(name: string | undefined, email: string | undefined): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
  }
  const handle = (email ?? '?').trim();
  const first = handle.charAt(0);
  return (first ? first : '?').toUpperCase();
}
