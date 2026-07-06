/**
 * Parseo de contactos importados desde **vCard (.vcf)** y **CSV** (los formatos que exportan iPhone,
 * Google Contacts y Outlook). PURO y testeable: no toca DB. Devuelve una lista normalizada; el endpoint
 * decide qué persistir/deduplicar. Robusto ante entrada parcial (un contacto sin email o sin nombre no
 * rompe el resto).
 */

export interface ParsedContact {
  fullName: string;
  /** Email primario (el primero encontrado). Puede ser '' si el contacto no trae email. */
  email: string;
  emails: { label: string; address: string }[];
  phones: { label: string; number: string }[];
  organization?: string;
  jobTitle?: string;
  notes?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Detecta el formato por el contenido (vCard tiene BEGIN:VCARD; si no, CSV). */
export function detectImportFormat(content: string): 'vcard' | 'csv' {
  return /BEGIN:VCARD/i.test(content) ? 'vcard' : 'csv';
}

/** Parsea según el formato (auto-detectado si no se pasa). */
export function parseContacts(content: string, format?: 'vcard' | 'csv'): ParsedContact[] {
  const fmt = format ?? detectImportFormat(content);
  return fmt === 'vcard' ? parseVCards(content) : parseCsv(content);
}

// ─────────────────────────────── vCard ───────────────────────────────

/** Des-escapa un valor de vCard (`\n` → salto, `\,` `\;` `\\` → literales). */
function unescapeVCard(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

/** Etiqueta legible desde los TYPE de una propiedad (WORK→Trabajo, HOME→Personal, CELL→Móvil…). */
function labelFromTypes(params: string[]): string {
  const t = /type=([a-z,]+)/.exec(params.join(';').toLowerCase())?.[1];
  if (!t) return 'Otro';
  if (t.includes('work')) return 'Trabajo';
  if (t.includes('home')) return 'Personal';
  if (t.includes('cell') || t.includes('mobile')) return 'Móvil';
  return 'Otro';
}

/**
 * Parsea uno o más bloques BEGIN:VCARD…END:VCARD. Maneja el line-folding (líneas continuadas que empiezan
 * con espacio/tab), múltiples EMAIL/TEL con sus TYPE, FN o N para el nombre, ORG, TITLE, NOTE.
 */
export function parseVCards(text: string): ParsedContact[] {
  // 1) Unfold: una línea que empieza con espacio o tab continúa la anterior (RFC 6350).
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const out: ParsedContact[] = [];
  const blocks = unfolded.split(/BEGIN:VCARD/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/END:VCARD/i)[0];
    let fn = '';
    let nStructured = '';
    const emails: { label: string; address: string }[] = [];
    const phones: { label: string; number: string }[] = [];
    let organization: string | undefined;
    let jobTitle: string | undefined;
    let notes: string | undefined;

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const left = line.slice(0, colon);
      const value = unescapeVCard(line.slice(colon + 1).trim());
      if (!value) continue;
      const parts = left.split(';');
      const name = parts[0].toUpperCase();

      if (name === 'FN') fn = value;
      else if (name === 'N' && !nStructured) {
        // N:Apellido;Nombre;… → "Nombre Apellido"
        const [last = '', first = ''] = value.split(';');
        nStructured = [first, last].filter(Boolean).join(' ').trim();
      } else if (name === 'EMAIL') {
        if (EMAIL_RE.test(value))
          emails.push({ label: labelFromTypes(parts), address: value.toLowerCase() });
      } else if (name === 'TEL') {
        phones.push({ label: labelFromTypes(parts), number: value });
      } else if (name === 'ORG') organization = value.split(';')[0].trim() || undefined;
      else if (name === 'TITLE') jobTitle = value;
      else if (name === 'NOTE') notes = value;
    }

    const fullName = (fn || nStructured || emails[0]?.address || '').trim();
    if (!fullName && emails.length === 0) continue; // vacío: nada útil
    out.push({
      fullName: fullName || emails[0].address,
      email: emails[0]?.address ?? '',
      emails,
      phones,
      organization,
      jobTitle,
      notes,
    });
  }
  return out;
}

// ─────────────────────────────── CSV ───────────────────────────────

/** Tokeniza una línea/archivo CSV (RFC 4180: comillas dobles, comas y saltos dentro de comillas). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parsea CSV de contactos. Mapea las columnas por HEADER de forma flexible (Google/Outlook/iPhone usan
 * nombres distintos): busca columnas de nombre, email(es), teléfono(s), organización, cargo y notas por
 * patrones. Une varias columnas "E-mail N - Value" en `emails[]`.
 */
export function parseCsv(text: string): ParsedContact[] {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idxs = (re: RegExp): number[] =>
    header.map((h, i) => (re.test(h) ? i : -1)).filter((i) => i >= 0);

  // Nombre: "name"/"display name"/"full name"; si no, "given/first" + "family/last".
  const nameIdx = header.findIndex((h) => /^(name|display name|full name)$/.test(h));
  const firstIdx = header.findIndex((h) => /(given|first) name/.test(h));
  const lastIdx = header.findIndex((h) => /(family|last) name/.test(h));
  const emailIdxs = idxs(/e-?mail/);
  const phoneIdxs = idxs(/phone|tel|mobile|móvil|movil/);
  const orgIdx = header.findIndex((h) => /organization|company|empresa|organizaci/.test(h));
  const titleIdx = header.findIndex((h) => /title|job|cargo|puesto/.test(h) && !/e-?mail/.test(h));
  const noteIdx = header.findIndex((h) => /note|nota/.test(h));

  const out: ParsedContact[] = [];
  for (const r of rows.slice(1)) {
    const cell = (i: number): string => (i >= 0 && i < r.length ? r[i].trim() : '');
    let fullName = cell(nameIdx);
    if (!fullName) fullName = [cell(firstIdx), cell(lastIdx)].filter(Boolean).join(' ').trim();

    const emails = emailIdxs
      .map((i) => cell(i))
      .flatMap((v) => v.split(/[;,]/).map((x) => x.trim())) // Google mete varios en una celda con ::: o ,
      .filter((v) => EMAIL_RE.test(v))
      .map((address, k) => ({
        label: k === 0 ? 'Trabajo' : 'Otro',
        address: address.toLowerCase(),
      }));
    // dedup emails por dirección
    const seenE = new Set<string>();
    const uniqEmails = emails.filter((e) => (seenE.has(e.address) ? false : seenE.add(e.address)));

    const phones = phoneIdxs
      .map((i) => cell(i))
      .flatMap((v) => v.split(/[;]/).map((x) => x.trim()))
      .filter(Boolean)
      .map((number, k) => ({ label: k === 0 ? 'Móvil' : 'Otro', number }));

    if (!fullName && uniqEmails.length === 0) continue;
    out.push({
      fullName: fullName || uniqEmails[0].address,
      email: uniqEmails[0]?.address ?? '',
      emails: uniqEmails,
      phones,
      organization: cell(orgIdx) || undefined,
      jobTitle: cell(titleIdx) || undefined,
      notes: cell(noteIdx) || undefined,
    });
  }
  return out;
}
