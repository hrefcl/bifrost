import { DockerMailserverProvider } from './docker-mailserver.js';
import { getMailboxConfig } from './config.js';
import { ProvisioningDisabledError, type MailboxProvider } from './types.js';

export type { MailboxProvider, MailboxProviderType } from './types.js';
export { ProvisioningDisabledError, MailboxExistsError } from './types.js';
export {
  getMailboxConfig,
  setMailboxConfig,
  seedMailboxConfigFromEnv,
  type MailboxConfig,
  type MailboxConfigInput,
  type DockerMailserverSettings,
} from './config.js';

/** Provider `none`: el server no crea buzones. `createMailbox`/`deleteMailbox` lanzan; existe → false. */
class NullMailboxProvider implements MailboxProvider {
  readonly type = 'none' as const;
  createMailbox(): Promise<void> {
    return Promise.reject(new ProvisioningDisabledError());
  }
  deleteMailbox(): Promise<void> {
    return Promise.reject(new ProvisioningDisabledError());
  }
  mailboxExists(): Promise<boolean> {
    return Promise.resolve(false);
  }
  listMailboxes(): Promise<string[]> {
    return Promise.resolve([]);
  }
  getRawLine(): Promise<string | null> {
    return Promise.resolve(null);
  }
  setPassword(): Promise<void> {
    return Promise.reject(new ProvisioningDisabledError());
  }
  addRawLine(): Promise<void> {
    return Promise.reject(new ProvisioningDisabledError());
  }
  getAliases(): Promise<string[]> {
    return Promise.resolve([]);
  }
  getAllAliases(): Promise<Map<string, string>> {
    return Promise.resolve(new Map<string, string>());
  }
  setAliases(): Promise<void> {
    return Promise.reject(new ProvisioningDisabledError());
  }
  buildAccountLine(): string {
    throw new ProvisioningDisabledError();
  }
}

/** Provider de provisioning ACTIVO según la config del admin/seed. Nunca devuelve undefined. */
export async function getActiveMailboxProvider(): Promise<MailboxProvider> {
  const cfg = await getMailboxConfig();
  switch (cfg.providerType) {
    case 'docker-mailserver':
      if (!cfg.dockerMailserver?.accountsFile) return new NullMailboxProvider();
      return new DockerMailserverProvider(
        cfg.dockerMailserver.accountsFile,
        cfg.dockerMailserver.maildataDir
      );
    case 'none':
    default:
      return new NullMailboxProvider();
  }
}

/** ¿El server puede crear buzones? (para exponer/ocultar el alta real en el admin). */
export async function provisioningEnabled(): Promise<boolean> {
  return (await getMailboxConfig()).providerType !== 'none';
}
