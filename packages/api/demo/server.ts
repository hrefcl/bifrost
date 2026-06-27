/**
 * MODO DEMO LOCAL (sólo interfaz, sin envíos reales).
 *
 * Levanta la API REAL contra infraestructura efímera/fake y siembra datos para clickear la UI:
 *   - MongoDB  → mongodb-memory-server (en RAM, se descarta al salir).
 *   - Redis    → ioredis-mock.
 *   - IMAP/SMTP→ fakes en-proceso (NADA se envía ni sale a Internet).
 *   - Seed     → un usuario y un admin, con la mailbox de demo YA sincronizada (inbox poblado).
 * Además spawnea el dev server de la web (Vite :5173, proxy /api → :3000) como proceso hijo,
 * así `pnpm demo` levanta todo con un solo comando. Ctrl-C corta ambos.
 *
 * Logins (password: cualquiera — el IMAP es fake y acepta todo):
 *   - Usuario: demo@example.com
 *   - Admin:   admin@example.com   (ve además el panel /admin)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const API_PORT = 3000;
const WEB_PORT = 5173;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function main(): Promise<void> {
  // 1) Env del demo (TTL largo para no andar refrescando token; logs informativos).
  const mongo = await MongoMemoryServer.create();
  // NODE_ENV=test: requerido para inyectar los transportes fake (el seam lo exige) y para
  // cookies no-Secure sobre http localhost. No es producción.
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongo.getUri();
  process.env.REDIS_URL = 'mock';
  process.env.JWT_SECRET = 'demo-jwt-secret-demo-jwt-secret-0123456789';
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.JWT_ACCESS_TTL = '12h';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
  process.env.ATTACHMENTS_DIR = path.join(tmpdir(), 'bifrost-demo-attachments');

  // 2) Inyectar transportes fake (nada sale a Internet).
  const { setImapClientFactory, setSmtpTransportFactory } =
    await import('../src/services/mail-transport.js');
  const { FakeImapClient, FakeSmtpTransport } = await import('../e2e/fake-mail.js');
  setImapClientFactory(() => new FakeImapClient() as never);
  setSmtpTransportFactory(() => new FakeSmtpTransport() as never);

  await mongoose.connect(process.env.MONGODB_URI);

  // 3) Seed: un usuario y un admin, con su mailbox de demo ya sincronizada.
  const { User } = await import('../src/models/User.js');
  const { Account } = await import('../src/models/Account.js');
  const { listAndSyncFolders, syncFolderHeaders } = await import('../src/services/imap.js');
  const { Folder } = await import('../src/models/Folder.js');

  async function seed(email: string, role: 'user' | 'admin'): Promise<void> {
    const user = await User.create({ primaryEmail: email, displayName: email.split('@')[0], role });
    const account = new Account({
      userId: user._id,
      name: email,
      email,
      isPrimary: true,
      imap: {
        host: 'imap.demo',
        port: 993,
        secure: true,
        authMethod: 'password',
        authUser: email,
        authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
        compress: false,
        preferredProtocol: 'imap',
      },
      smtp: {
        host: 'smtp.demo',
        port: 465,
        secure: true,
        authMethod: 'password',
        authUser: email,
        authCredentialsEncrypted: { ciphertext: '', iv: '', tag: '' },
      },
      status: 'active',
    });
    account.setImapCredentials('demo-pass');
    account.setSmtpCredentials('demo-pass');
    await account.save();
    // Sincronizar folders + headers desde el IMAP fake → el inbox queda poblado.
    await listAndSyncFolders(account);
    const folders = await Folder.find({ accountId: account._id });
    for (const f of folders) await syncFolderHeaders(account, f._id.toString());
  }

  await seed('demo@example.com', 'user');
  await seed('admin@example.com', 'admin');

  // 4) Levantar la API real.
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp();
  await app.listen({ port: API_PORT, host: '127.0.0.1' });

  // 5) Spawnear el dev server de la web (proxy /api → :3000).
  const web = spawn('pnpm', ['--filter', '@webmail6/web', 'dev'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  const banner = [
    '',
    '  ╔══════════════════════════════════════════════════════════════╗',
    '  ║   WEBMAIL 6.0 — DEMO LOCAL (sólo interfaz, nada se envía)     ║',
    '  ╠══════════════════════════════════════════════════════════════╣',
    `  ║   Abrí:   http://localhost:${WEB_PORT}/login`.padEnd(64) + '║',
    '  ║                                                              ║',
    '  ║   Usuario:  demo@example.com   · pass: cualquiera            ║',
    '  ║   Admin:    admin@example.com  · pass: cualquiera            ║',
    '  ║                                                              ║',
    '  ║   Mongo en RAM · IMAP/SMTP fake · Ctrl-C corta todo          ║',
    '  ╚══════════════════════════════════════════════════════════════╝',
    '',
  ].join('\n');
  setTimeout(() => console.log(banner), 1500); // tras el arranque de Vite

  const shutdown = (): void => {
    web.kill('SIGTERM');
    void app.close().then(() => mongoose.disconnect().then(() => mongo.stop()));
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  web.on('exit', shutdown);
}

main().catch((err: unknown) => {
  console.error('[demo] fallo al arrancar:', err);
  process.exit(1);
});
