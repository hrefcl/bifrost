import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { DockerMailserverProvider } from '../docker-mailserver.js';
import { MailboxExistsError } from '../types.js';

let dir: string;
let accountsFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dms-prov-'));
  accountsFile = path.join(dir, 'postfix-accounts.cf');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readFile(): Promise<string> {
  return fs.readFile(accountsFile, 'utf8');
}

describe('DockerMailserverProvider', () => {
  it('crea una línea con hash Dovecot {BLF-CRYPT}$2y$ verificable', async () => {
    const p = new DockerMailserverProvider(accountsFile);
    await p.createMailbox('User@Cleverty.info', 's3cret-pass');

    const content = await readFile();
    const line = content.trim();
    // email normalizado a minúsculas + separador |
    expect(line.startsWith('user@cleverty.info|')).toBe(true);
    const hash = line.split('|')[1];
    expect(hash.startsWith('{BLF-CRYPT}$2y$')).toBe(true);
    // El hash real valida la contraseña (sin el prefijo {BLF-CRYPT}).
    const raw = hash.replace('{BLF-CRYPT}', '');
    expect(bcrypt.compareSync('s3cret-pass', raw)).toBe(true);
    expect(bcrypt.compareSync('wrong', raw)).toBe(false);
  });

  it('mailboxExists es case-insensitive', async () => {
    const p = new DockerMailserverProvider(accountsFile);
    await p.createMailbox('ana@cleverty.info', 'x');
    expect(await p.mailboxExists('ANA@cleverty.info')).toBe(true);
    expect(await p.mailboxExists('otro@cleverty.info')).toBe(false);
  });

  it('rechaza duplicados con MailboxExistsError (case-insensitive) sin pisar la línea', async () => {
    const p = new DockerMailserverProvider(accountsFile);
    await p.createMailbox('ana@cleverty.info', 'first');
    const before = await readFile();
    await expect(p.createMailbox('ANA@cleverty.info', 'second')).rejects.toBeInstanceOf(
      MailboxExistsError
    );
    // No se agregó ni modificó nada.
    expect(await readFile()).toBe(before);
    expect((await readFile()).trim().split('\n')).toHaveLength(1);
  });

  it('deleteMailbox quita sólo la línea objetivo y preserva el resto', async () => {
    const p = new DockerMailserverProvider(accountsFile);
    await p.createMailbox('ana@cleverty.info', 'x');
    await p.createMailbox('beto@cleverty.info', 'y');
    await p.deleteMailbox('ana@cleverty.info');

    expect(await p.mailboxExists('ana@cleverty.info')).toBe(false);
    expect(await p.mailboxExists('beto@cleverty.info')).toBe(true);
    expect((await readFile()).trim().split('\n')).toHaveLength(1);
  });

  it('borra el Maildir sólo si se pide purgeMaildir', async () => {
    const maildata = path.join(dir, 'maildata');
    const maildir = path.join(maildata, 'cleverty.info', 'ana');
    await fs.mkdir(maildir, { recursive: true });
    await fs.writeFile(path.join(maildir, 'msg'), 'hola');

    const p = new DockerMailserverProvider(accountsFile, maildata);
    await p.createMailbox('ana@cleverty.info', 'x');

    // Sin purge: el Maildir sobrevive.
    await p.deleteMailbox('ana@cleverty.info');
    expect(
      await fs
        .stat(maildir)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);

    // Con purge: se elimina.
    await p.createMailbox('ana@cleverty.info', 'x');
    await p.deleteMailbox('ana@cleverty.info', { purgeMaildir: true });
    expect(
      await fs
        .stat(maildir)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  it('el lock serializa altas concurrentes sin corromper ni perder líneas', async () => {
    const p = new DockerMailserverProvider(accountsFile);
    const emails = Array.from({ length: 20 }, (_, i) => `user${String(i)}@cleverty.info`);
    // Todas en paralelo: el write-lock debe serializarlas (read-modify-write atómico).
    await Promise.all(emails.map((e) => p.createMailbox(e, 'pw')));

    const lines = (await readFile()).trim().split('\n');
    expect(lines).toHaveLength(20);
    // Sin líneas vacías ni malformadas; todos los emails presentes exactamente una vez.
    const seen = new Set(lines.map((l) => l.split('|')[0]));
    expect(seen.size).toBe(20);
    for (const e of emails) expect(seen.has(e)).toBe(true);
  });

  it('createMailbox funciona aunque el archivo no exista todavía (ENOENT → vacío)', async () => {
    const p = new DockerMailserverProvider(accountsFile);
    // No creamos el archivo previamente.
    await p.createMailbox('ana@cleverty.info', 'x');
    expect(await p.mailboxExists('ana@cleverty.info')).toBe(true);
  });
});

describe('setAliases — hardening (review MED-2/LOW-1)', () => {
  async function virtual(): Promise<string> {
    return fs.readFile(path.join(dir, 'postfix-virtual.cf'), 'utf8');
  }

  it('descarta el auto-alias (target→target): no escribe una línea `self self`', async () => {
    const p = new DockerMailserverProvider(accountsFile);
    await p.createMailbox('ana@x.com', 'pw');
    await p.setAliases('ana@x.com', ['ana@x.com', 'info@x.com']);
    const v = await virtual();
    expect(v).toContain('info@x.com ana@x.com');
    expect(v).not.toContain('ana@x.com ana@x.com'); // el auto-alias se filtró
    expect(await p.getAliases('ana@x.com')).toEqual(['info@x.com']);
  });

  it('rechaza un alias con formato inválido (defensa anti-inyección) sin escribir el archivo', async () => {
    const p = new DockerMailserverProvider(accountsFile);
    await p.createMailbox('ana@x.com', 'pw');
    await p.setAliases('ana@x.com', ['ok@x.com']); // set inicial válido
    await expect(p.setAliases('ana@x.com', ['evil@x.com hijack@y.com'])).rejects.toThrow(
      /formato inválido/
    );
    // El archivo NO se tocó: sigue el set válido anterior (sin la línea inyectada).
    expect(await p.getAliases('ana@x.com')).toEqual(['ok@x.com']);
  });
});
