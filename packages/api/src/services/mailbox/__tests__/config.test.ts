import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, resetState } from '../../../../test/integration-helper.js';
import {
  getMailboxConfig,
  setMailboxConfig,
  seedMailboxConfigFromEnv,
  getActiveMailboxProvider,
  provisioningEnabled,
} from '../index.js';
import { DockerMailserverProvider } from '../docker-mailserver.js';
import { SystemConfig } from '../../../models/SystemConfig.js';

describe('mailbox provisioning config', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
    delete process.env.DMS_ACCOUNTS_FILE;
    delete process.env.DMS_MAILDATA_DIR;
  });
  afterEach(() => {
    delete process.env.DMS_ACCOUNTS_FILE;
    delete process.env.DMS_MAILDATA_DIR;
  });

  it('sin config → provider none, provisioning deshabilitado', async () => {
    expect((await getMailboxConfig()).providerType).toBe('none');
    expect(await provisioningEnabled()).toBe(false);
    expect((await getActiveMailboxProvider()).type).toBe('none');
  });

  it('el provider none lanza al crear/borrar y existe→false', async () => {
    const p = await getActiveMailboxProvider();
    await expect(p.createMailbox('a@x.com', 'pw')).rejects.toThrow();
    await expect(p.deleteMailbox('a@x.com')).rejects.toThrow();
    expect(await p.mailboxExists('a@x.com')).toBe(false);
  });

  it('seedMailboxConfigFromEnv materializa docker-mailserver desde el entorno (turnkey)', async () => {
    process.env.DMS_ACCOUNTS_FILE = '/tmp/accounts.cf';
    process.env.DMS_MAILDATA_DIR = '/tmp/maildata';
    expect(await seedMailboxConfigFromEnv()).toBe(true);

    const cfg = await getMailboxConfig();
    expect(cfg.providerType).toBe('docker-mailserver');
    expect(cfg.dockerMailserver).toEqual({
      accountsFile: '/tmp/accounts.cf',
      maildataDir: '/tmp/maildata',
    });
    expect(cfg.updatedBy).toBe('system:env-seed');
    expect(await provisioningEnabled()).toBe(true);

    const provider = await getActiveMailboxProvider();
    expect(provider).toBeInstanceOf(DockerMailserverProvider);
    expect(provider.type).toBe('docker-mailserver');
  });

  it('seed no hace nada sin DMS_ACCOUNTS_FILE', async () => {
    expect(await seedMailboxConfigFromEnv()).toBe(false);
    expect(await SystemConfig.findOne({ key: 'mailbox-provisioning' })).toBeNull();
  });

  it('seed NO pisa una config existente (el admin manda)', async () => {
    await setMailboxConfig({ providerType: 'none' }, 'admin:1');
    process.env.DMS_ACCOUNTS_FILE = '/tmp/accounts.cf';
    expect(await seedMailboxConfigFromEnv()).toBe(false);
    expect((await getMailboxConfig()).providerType).toBe('none');
  });

  it('setMailboxConfig persiste la elección del admin y sella updatedBy/At', async () => {
    const saved = await setMailboxConfig(
      {
        providerType: 'docker-mailserver',
        dockerMailserver: { accountsFile: '/opt/accounts.cf' },
      },
      'admin:42'
    );
    expect(saved.providerType).toBe('docker-mailserver');
    expect(saved.updatedBy).toBe('admin:42');
    expect(saved.updatedAt).toBeTruthy();
    expect((await getMailboxConfig()).dockerMailserver?.accountsFile).toBe('/opt/accounts.cf');
  });

  it('docker-mailserver sin accountsFile cae a none (defensa ante config corrupta)', async () => {
    // Escritura cruda de una config inválida (bypass del schema) para probar la defensa del index.
    await SystemConfig.findOneAndUpdate(
      { key: 'mailbox-provisioning' },
      { $set: { value: { providerType: 'docker-mailserver' } } },
      { upsert: true }
    );
    expect((await getActiveMailboxProvider()).type).toBe('none');
  });
});
