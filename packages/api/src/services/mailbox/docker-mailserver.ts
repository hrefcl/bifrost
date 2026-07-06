/**
 * Provider `docker-mailserver` — el turnkey de Bifrost.
 *
 * docker-mailserver guarda las cuentas en `postfix-accounts.cf` (`email|{SCHEME}hash`, una por línea) y
 * su `changedetector` reaplica el archivo automáticamente ante cualquier cambio. Montando ese archivo en
 * el contenedor `api` (volumen compartido), Bifrost CREA/BORRA buzones **sin docker socket** (que sería
 * acceso root al host) y sin claves AWS ni SSH al EC2.
 *
 * Hash: bcrypt (`{BLF-CRYPT}`) — Dovecot lo acepta nativo (verificado empíricamente) y bcryptjs es JS puro
 * (sin build nativo → anda en la imagen Docker). El marcador de versión se normaliza a `$2y$` (el que
 * emite doveadm); `$2b$`/`$2y$` son el mismo algoritmo (crypt_blowfish los trata igual).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { AliasConflictError, MailboxExistsError, type MailboxProvider } from './types.js';

/** Genera el hash Dovecot para `password`. bcrypt cost 10; prefijo normalizado a `{BLF-CRYPT}$2y$`. */
function hashPassword(password: string): string {
  const h = bcrypt.hashSync(password, 10).replace(/^\$2[ab]\$/, '$2y$');
  return `{BLF-CRYPT}${h}`;
}

function emailOf(line: string): string {
  return line.split('|')[0]?.trim().toLowerCase() ?? '';
}

export class DockerMailserverProvider implements MailboxProvider {
  readonly type = 'docker-mailserver' as const;

  // Serializa escrituras al archivo (in-process; una sola instancia de api escribe el volumen compartido
  // → suficiente). Evita corromper el postfix-accounts.cf ante altas/bajas concurrentes.
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly accountsFile: string,
    private readonly maildataDir?: string
  ) {}

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async readLines(): Promise<string[]> {
    const content = await fs.readFile(this.accountsFile, 'utf8').catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    });
    return content.split('\n').filter((l) => l.trim().length > 0);
  }

  private async writeLines(lines: string[]): Promise<void> {
    // Escritura atómica: temp + rename (el changedetector nunca ve un archivo a medias).
    const tmp = `${this.accountsFile}.tmp-${String(process.pid)}`;
    await fs.writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    await fs.rename(tmp, this.accountsFile);
  }

  async mailboxExists(email: string): Promise<boolean> {
    const target = email.trim().toLowerCase();
    return (await this.readLines()).some((l) => emailOf(l) === target);
  }

  async createMailbox(email: string, password: string): Promise<void> {
    const target = email.trim().toLowerCase();
    const line = `${target}|${hashPassword(password)}`;
    await this.withLock(async () => {
      const lines = await this.readLines();
      if (lines.some((l) => emailOf(l) === target)) throw new MailboxExistsError(target);
      lines.push(line);
      await this.writeLines(lines);
    });
  }

  async deleteMailbox(email: string, opts: { purgeMaildir?: boolean } = {}): Promise<void> {
    const target = email.trim().toLowerCase();
    await this.withLock(async () => {
      const lines = await this.readLines();
      await this.writeLines(lines.filter((l) => emailOf(l) !== target));
    });
    if (opts.purgeMaildir && this.maildataDir) {
      // <maildata>/<dominio>/<usuario>. Best-effort: si falla, la cuenta ya perdió acceso igual.
      const [user, domain] = target.split('@');
      if (user && domain) {
        const dir = path.join(this.maildataDir, domain, user);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /** Lista los emails de todos los buzones ACTIVOS (líneas del accounts.cf). */
  async listMailboxes(): Promise<string[]> {
    return (await this.readLines()).map(emailOf).filter(Boolean);
  }

  /** Devuelve la línea cruda `email|hash` del buzón, o null si no existe. */
  async getRawLine(email: string): Promise<string | null> {
    const target = email.trim().toLowerCase();
    return (await this.readLines()).find((l) => emailOf(l) === target) ?? null;
  }

  /** Cambia la contraseña de un buzón EXISTENTE (reemplaza el hash de su línea). Lanza si no existe. */
  async setPassword(email: string, password: string): Promise<void> {
    const target = email.trim().toLowerCase();
    const newLine = `${target}|${hashPassword(password)}`;
    await this.withLock(async () => {
      const lines = await this.readLines();
      const idx = lines.findIndex((l) => emailOf(l) === target);
      if (idx < 0) throw new Error(`El buzón ${target} no existe.`);
      lines[idx] = newLine;
      await this.writeLines(lines);
    });
  }

  /** Construye la línea `email|hash` para `password` (no escribe). Reescribir el hash de un suspendido. */
  buildAccountLine(email: string, password: string): string {
    return `${email.trim().toLowerCase()}|${hashPassword(password)}`;
  }

  /** Asegura que la línea cruda `email|hash` EXACTA esté presente (reactivar un buzón suspendido sin
   *  perder la password). Si ya hay una línea para ese email con distinto hash, la REEMPLAZA: la línea
   *  guardada es la fuente de verdad al reactivar (Bifrost es la autoridad). Idempotente por línea exacta. */
  async addRawLine(rawLine: string): Promise<void> {
    const target = emailOf(rawLine);
    const clean = rawLine.trim();
    await this.withLock(async () => {
      const lines = await this.readLines();
      const idx = lines.findIndex((l) => emailOf(l) === target);
      if (idx >= 0) {
        if (lines[idx] === clean) return; // ya exacta → no reescribir
        lines[idx] = clean; // reemplaza el hash viejo por el guardado (convergencia real)
      } else {
        lines.push(clean);
      }
      await this.writeLines(lines);
    });
  }

  private get virtualFile(): string {
    return path.join(path.dirname(this.accountsFile), 'postfix-virtual.cf');
  }

  /** Aliases (target → email) del buzón, desde postfix-virtual.cf (`alias target` por línea). */
  async getAliases(email: string): Promise<string[]> {
    const target = email.trim().toLowerCase();
    const content = await fs.readFile(this.virtualFile, 'utf8').catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    });
    return content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/))
      .filter((p) => p[1]?.toLowerCase() === target)
      .map((p) => p[0].toLowerCase());
  }

  /** Todos los aliases como mapa `alias → destino` (una sola lectura del postfix-virtual.cf). */
  async getAllAliases(): Promise<Map<string, string>> {
    const content = await fs.readFile(this.virtualFile, 'utf8').catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    });
    const map = new Map<string, string>();
    for (const line of content.split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const [alias, target] = l.split(/\s+/);
      if (alias && target) map.set(alias.toLowerCase(), target.toLowerCase());
    }
    return map;
  }

  /** Reemplaza el set de aliases que apuntan a `email` en postfix-virtual.cf (escritura atómica). */
  async setAliases(email: string, aliases: string[]): Promise<void> {
    const target = email.trim().toLowerCase();
    const clean = [...new Set(aliases.map((a) => a.trim().toLowerCase()).filter(Boolean))];
    await this.withLock(async () => {
      const content = await fs.readFile(this.virtualFile, 'utf8').catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw e;
      });
      const rows = content
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      // Unicidad global: si un alias pedido ya apunta a OTRO buzón, es conflicto (no lo robamos).
      const ownedByOthers = new Set(
        rows
          .filter((l) => !l.startsWith('#'))
          .map((l) => l.split(/\s+/))
          .filter((p) => p[1]?.toLowerCase() !== target)
          .map((p) => p[0].toLowerCase())
      );
      const conflict = clean.find((a) => ownedByOthers.has(a));
      if (conflict) throw new AliasConflictError(conflict);
      // Conserva las líneas que NO apuntan a este email; agrega las nuevas.
      const kept = rows.filter(
        (l) => l.startsWith('#') || l.split(/\s+/)[1]?.toLowerCase() !== target
      );
      const added = clean.map((a) => `${a} ${target}`);
      const out = [...kept, ...added].join('\n') + '\n';
      const tmp = `${this.virtualFile}.tmp-${String(process.pid)}`;
      await fs.writeFile(tmp, out, { mode: 0o600 });
      await fs.rename(tmp, this.virtualFile);
    });
  }
}
