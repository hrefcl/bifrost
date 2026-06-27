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

  /** Resuelve la ruta de una key y verifica que NO escape del root (anti traversal). */
  private resolveKey(key: string): string {
    const full = path.resolve(this.root, key);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (full !== this.root && !full.startsWith(rootWithSep)) {
      throw new Error('Invalid storage key (path traversal)');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const dest = this.resolveKey(key);
    const tmp = `${dest}.${randomUUID()}.tmp`;
    await writeFile(tmp, body, { flag: 'wx' }); // wx: falla si el tmp ya existe
    await rename(tmp, dest); // rename atómico dentro del mismo fs
  }

  async get(key: string): Promise<Buffer> {
    // async: que un key inválido (resolveKey throw) sea un rejected promise, no un throw síncrono.
    return readFile(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true }); // force: idempotente si no existe
  }
}
