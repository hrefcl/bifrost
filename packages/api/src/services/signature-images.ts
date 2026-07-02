import { createHash } from 'node:crypto';
import { SignatureImage } from '../models/SignatureImage.js';

export const MAX_IMG_BYTES = 2 * 1024 * 1024; // 2MB por imagen (foto de perfil de firma)
const RASTER = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
// Captura el data: URI de imágenes embebidas (en src="..." o src='...').
const DATA_IMG_RE = /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)/gi;
// Un data: URL ráster COMPLETO (para storeDataImage — foto de perfil subida sola, no embebida en HTML).
const FULL_DATA_IMG_RE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i;

/** Guarda un buffer ráster (dedup por userId+hash) y devuelve la URL pública hosteada, o null. */
async function persistImage(
  userId: string,
  contentType: string,
  buf: Buffer,
  baseUrl: string
): Promise<string | null> {
  if (!RASTER.test(contentType) || buf.length === 0 || buf.length > MAX_IMG_BYTES) return null;
  const hash = createHash('sha256').update(buf).digest('hex');
  const doc = await SignatureImage.findOneAndUpdate(
    { userId, hash },
    { $setOnInsert: { userId, hash, contentType, data: buf, size: buf.length } },
    { upsert: true, new: true }
  );
  return `${baseUrl.replace(/\/+$/, '')}/api/signature-images/${doc._id.toString()}`;
}

/**
 * Sube una foto de perfil de firma pasada como data: URL ráster COMPLETO → URL pública hosteada
 * (`${baseUrl}/api/signature-images/:id`). Devuelve null si el data: es inválido/pesado/no-ráster.
 * NUNCA acepta URLs remotas (review firmas H2: la foto sólo puede ser interna, no un tracker externo).
 */
export async function storeDataImage(
  userId: string,
  dataUrl: string,
  baseUrl: string
): Promise<string | null> {
  const m = FULL_DATA_IMG_RE.exec(dataUrl.trim());
  if (!m) return null;
  const [, contentType, b64] = m;
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  return persistImage(userId, contentType, buf, baseUrl);
}

/**
 * Reemplaza las imágenes `data:` (base64) embebidas en `html` por URLs públicas hosteadas en el box,
 * subiendo cada imagen (dedup por hash). Necesario porque Gmail y otros clientes BLOQUEAN data: en
 * correos recibidos → la foto de la firma se vería rota. `baseUrl` = origen público (FRONTEND_URL).
 * Sólo ráster y bajo el límite de tamaño; un data: inválido se deja como está (el sanitizador decide).
 */
const MAX_EMBEDDED_IMAGES = 10; // límite anti-DoS por firma/mensaje

export async function externalizeDataImages(
  userId: string,
  html: string,
  baseUrl: string
): Promise<string> {
  const matches = [...html.matchAll(DATA_IMG_RE)].slice(0, MAX_EMBEDDED_IMAGES);
  if (matches.length === 0) return html;

  let out = html;
  for (const m of matches) {
    const [whole, contentType, b64] = m;
    if (!RASTER.test(contentType)) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    if (buf.length === 0 || buf.length > MAX_IMG_BYTES) continue;

    const hash = createHash('sha256').update(buf).digest('hex');
    // Upsert idempotente (dedup por userId+hash). findOneAndUpdate con upsert → un solo doc.
    const doc = await SignatureImage.findOneAndUpdate(
      { userId, hash },
      { $setOnInsert: { userId, hash, contentType, data: buf, size: buf.length } },
      { upsert: true, new: true }
    );
    const url = `${baseUrl.replace(/\/+$/, '')}/api/signature-images/${doc._id.toString()}`;
    out = out.split(whole).join(url);
  }
  return out;
}
