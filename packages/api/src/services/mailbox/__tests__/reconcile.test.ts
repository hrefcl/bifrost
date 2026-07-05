import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, teardownTestDb, resetState } from '../../../../test/integration-helper.js';
import { seedMailboxConfigFromEnv } from '../index.js';
import { reconcileMailboxes, countServerMailboxes } from '../reconcile.js';
import { Account } from '../../../models/Account.js';
import { User } from '../../../models/User.js';
import { syncStaleAccounts } from '../../account-sync.js';

/** (Re)escribe el postfix-accounts.cf de `file` con las líneas `email|hash` dadas. */
async function writeLines(file: string, emails: string[]): Promise<void> {
  await fs.writeFile(file, emails.map((e) => `${e}|{BLF-CRYPT}$2y$10$hash`).join('\n') + '\n');
}
/** Crea un postfix-accounts.cf temporal con las líneas dadas y devuelve su ruta. */
async function writeAccountsFile(emails: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reconcile-'));
  const file = path.join(dir, 'postfix-accounts.cf');
  await writeLines(file, emails);
  return file;
}

describe('reconcileMailboxes (importar buzones brownfield)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
    process.env.MAIL_SERVER_HOST = 'mail.test.com';
  });
  afterEach(() => {
    delete process.env.DMS_ACCOUNTS_FILE;
    delete process.env.DMS_MAILDATA_DIR;
    delete process.env.MAIL_SERVER_HOST;
  });

  async function enableProvisioning(emails: string[]): Promise<void> {
    process.env.DMS_ACCOUNTS_FILE = await writeAccountsFile(emails);
    await seedMailboxConfigFromEnv();
  }

  it('sin provisioning → no importa nada', async () => {
    const r = await reconcileMailboxes();
    expect(r.imported).toBe(0);
    expect(r.serverTotal).toBe(0);
    expect(await countServerMailboxes()).toBeNull();
  });

  it('importa los buzones del servidor que faltan y crea User+Account shell', async () => {
    await enableProvisioning(['a@x.com', 'b@x.com', 'c@x.com']);

    const r = await reconcileMailboxes();
    expect(r.serverTotal).toBe(3);
    expect(r.imported).toBe(3);
    expect(r.importedEmails.sort()).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);

    expect(await Account.countDocuments()).toBe(3);
    expect(await User.countDocuments()).toBe(3);
    expect(await countServerMailboxes()).toBe(3);

    const a = await Account.findOne({ email: 'a@x.com' });
    expect(a?.status).toBe('active');
    expect(a?.isPrimary).toBe(true);
    expect(a?.imap.host).toBe('mail.test.com');
    // Shell: sin credenciales de webmail (se vinculan al 1er login / reset de clave).
    expect(a?.imap.authCredentialsEncrypted.ciphertext).toBe('');
    // NUNCA importa como admin.
    const u = await User.findById(a?.userId);
    expect(u?.role).toBe('user');
  });

  it('es idempotente: sólo importa lo que falta', async () => {
    await enableProvisioning(['a@x.com', 'b@x.com']);
    await reconcileMailboxes();

    // Agregamos un tercero al MISMO accounts.cf (el provider lo lee en vivo); reejecutar importa sólo ese.
    await writeLines(process.env.DMS_ACCOUNTS_FILE!, ['a@x.com', 'b@x.com', 'c@x.com']);

    const r = await reconcileMailboxes();
    expect(r.imported).toBe(1);
    expect(r.importedEmails).toEqual(['c@x.com']);
    expect(await Account.countDocuments()).toBe(3);
  });

  it('el barrido de sync SALTA los buzones importados sin credenciales', async () => {
    await enableProvisioning(['a@x.com']);
    await reconcileMailboxes();
    // Sin credenciales cifradas no debe intentar sincronizar (ni marcarlos error): 0 cuentas procesadas.
    const r = await syncStaleAccounts();
    expect(r.accounts).toBe(0);
    // El shell no quedó en 'error' por el barrido.
    expect((await Account.findOne({ email: 'a@x.com' }))?.status).toBe('active');
  });
});
