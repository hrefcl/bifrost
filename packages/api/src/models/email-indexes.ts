/**
 * Specs de índices de Email compartidas SIN registrar el modelo Mongoose.
 *
 * Vive en un módulo aparte a propósito: importarlo NO ejecuta `mongoose.model('Email', ...)`
 * ni dispara autoIndex. Así `reconcile-indexes.ts` (y sus tests) pueden conocer la spec canónica
 * del índice de texto sin el efecto colateral de registrar el modelo y crear índices (que rompería,
 * p.ej., el test de dedup que necesita insertar duplicados antes de crear el índice único).
 */
export const EMAIL_TEXT_INDEX = {
  name: 'email_text_search',
  key: {
    accountId: 1,
    subject: 'text',
    preview: 'text',
    'from.name': 'text',
    'from.address': 'text',
  },
  weights: { subject: 10, 'from.name': 6, preview: 5, 'from.address': 3 },
} as const;
