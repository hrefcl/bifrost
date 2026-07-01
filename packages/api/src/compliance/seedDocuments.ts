import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComplianceDocument, type ComplianceCategory } from '../models/ComplianceDocument.js';
import { createDocument, createDraftVersion, publishVersion } from '../services/compliance.js';

/**
 * Seed idempotente de los 7 documentos `system` por defecto (DESIGN v4 §5). Patrón
 * `reconcile-indexes`: corre en boot, sólo crea lo que falta, NUNCA sobrescribe ediciones del admin.
 *
 * Conservador: se siembran `enforcement: 'soft'` (informativo, NO bloquea ningún login existente).
 * El admin opta conscientemente por `block_*` desde el editor (acto auditado).
 */

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seeds');
const LOCALES = ['es', 'en'] as const;
const SEED_EFFECTIVE_AT = new Date('2020-01-01T00:00:00Z'); // vigente desde siempre (no futuro)

interface SeedSpec {
  key: string;
  category: ComplianceCategory;
  titles: Record<string, string>;
  order: number;
}

const SEEDS: SeedSpec[] = [
  {
    key: 'terms-of-service',
    category: 'legal',
    order: 1,
    titles: { es: 'Términos de Servicio', en: 'Terms of Service' },
  },
  {
    key: 'privacy-policy',
    category: 'privacy',
    order: 2,
    titles: { es: 'Política de Privacidad', en: 'Privacy Policy' },
  },
  {
    key: 'acceptable-use',
    category: 'legal',
    order: 3,
    titles: { es: 'Política de Uso Aceptable', en: 'Acceptable Use Policy' },
  },
  {
    key: 'cookie-policy',
    category: 'cookies',
    order: 4,
    titles: { es: 'Política de Cookies', en: 'Cookie Policy' },
  },
  {
    key: 'data-retention',
    category: 'operational',
    order: 5,
    titles: { es: 'Política de Retención de Información', en: 'Data Retention Policy' },
  },
  {
    key: 'audit-policy',
    category: 'security',
    order: 6,
    titles: { es: 'Política de Auditoría', en: 'Audit Policy' },
  },
  {
    key: 'security-policy',
    category: 'security',
    order: 7,
    titles: { es: 'Política de Seguridad', en: 'Security Policy' },
  },
];

async function readSeedBody(key: string, locale: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(SEED_DIR, key, `${locale}.md`), 'utf8');
    // Sustituye el placeholder de fecha por la vigencia del seed.
    return raw.replaceAll('{{EFFECTIVE_DATE}}', SEED_EFFECTIVE_AT.toISOString().slice(0, 10));
  } catch {
    return null;
  }
}

/** Siembra los documentos faltantes. Devuelve cuántos se crearon. Idempotente. */
// Mínimo legal que DEBE forzarse en cuentas nuevas (abre el modal de aceptación). El resto se siembra
// `soft` (informativo). Decisión de producto (PM): un webmail nuevo debe exigir Términos + Privacidad
// antes de usarse. Es seguro para deploys EXISTENTES: el seeder es idempotente (no re-siembra si ya
// existen), así que sólo afecta instalaciones FRESCAS. El admin puede ajustarlo desde el editor.
const SEED_BLOCKING_KEYS = new Set(['terms-of-service', 'privacy-policy']);

export async function seedComplianceDocuments(tenantId = 'default'): Promise<number> {
  let created = 0;
  for (const spec of SEEDS) {
    const exists = await ComplianceDocument.findOne({ tenantId, key: spec.key }).lean();
    if (exists) continue; // nunca sobrescribe

    const contents: { locale: string; title: string; bodyMarkdown: string }[] = [];
    for (const locale of LOCALES) {
      const body = await readSeedBody(spec.key, locale);
      if (body)
        contents.push({ locale, title: spec.titles[locale] ?? spec.key, bodyMarkdown: body });
    }
    if (contents.length === 0) continue; // sin archivos de contenido → no se siembra

    try {
      const doc = await createDocument({
        tenantId,
        key: spec.key,
        category: spec.category,
        title: spec.titles.es,
        // Términos + Privacidad bloquean (abren el modal en cuenta nueva); el resto informativo.
        enforcement: SEED_BLOCKING_KEYS.has(spec.key) ? 'block_full' : 'soft',
        audience: 'all',
        order: spec.order,
        defaultLocale: 'es',
        system: true,
      });
      const version = await createDraftVersion({
        tenantId,
        documentId: doc._id,
        contents,
        changeSummary: 'Documento inicial sembrado por defecto',
        requiresReacceptance: false,
        effectiveAt: SEED_EFFECTIVE_AT,
      });
      await publishVersion(tenantId, version._id);
      created++;
    } catch (err: unknown) {
      // Boot concurrente multi-worker: otra instancia ganó la carrera del índice único (tenantId,key).
      // No es un error: el documento ya existe. E11000 directo o DUPLICATE_KEY del servicio.
      const code = (err as { code?: number | string }).code;
      if (code === 11000 || code === 'DUPLICATE_KEY') continue;
      throw err;
    }
  }
  return created;
}
