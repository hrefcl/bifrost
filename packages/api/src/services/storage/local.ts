import { mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StorageProvider } from './types.js';

/**
 * Storage en el MISMO servidor (filesystem). Default sin configuración → los adjuntos nunca
 * quedan bloqueados por falta de infra. Hardening (docs §6.bis-D):
 *  - `key` opaca generada server-side (uuid) — JAMÁS se concatena input del cliente al path,
 *    y se VERIFICA que el path resuelto quede dentro del root (defensa anti path-traversal).
 *  - write ATÓMICO (tmp + rename) → nunca se lee un archivo a medio escribir.
 *  - root configurable por `ATTACHMENTS_DIR` (default `./data/attachments`).
 */
export class LocalStorage implements StorageProvider {
  readonly type = 'local' as const;
  private readonly root: string;

  constructor(root?: string) {
    this.root = path.resolve(root ?? process.env.ATTACHMENTS_DIR ?? './data/attachments');
  }

  /**
   * Resuelve la ruta de una key y verifica que NO escape del root (anti traversal).
   * Rechaza además keys vacías, '.', '..' o cualquier componente que apunte al propio root,
   * porque permitirían leer/escribir/borrar el directorio de attachments.
   */
  private resolveKey(key: string): string {
    if (!key || typeof key !== 'string' || key.includes('\0')) {
      throw new Error('Invalid storage key');
    }
    // Rechazar componentes '.' / '..' y paths que no generen un archivo dentro del root.
    const parts = key.split(path.sep).filter((part) => part.length > 0);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
      throw new Error('Invalid storage key (path traversal)');
    }
    const full = path.resolve(this.root, key);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (!full.startsWith(rootWithSep)) {
      throw new Error('Invalid storage key (path traversal)');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const dest = this.resolveKey(key);
    const tmp = `${dest}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, body, { flag: 'wx' }); // wx: falla si el tmp ya existe
      await rename(tmp, dest); // rename atómico dentro del mismo fs
    } catch (err) {
      // Best-effort: no dejar tmp huérfano si writeFile/rename fallan (disco lleno, etc.).
      await rm(tmp, { force: true }).catch(() => {
        /* tmp puede no existir; ignorar errores de limpieza */
      });
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    // async: que un key inválido (resolveKey throw) sea un rejected promise, no un throw síncrono.
    return readFile(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true }); // force: idempotente si no existe
  }
}
