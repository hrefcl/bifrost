import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// "Servidor IMAP" simulado, hoisted para el mock.
const h = vi.hoisted(() => ({
  mailbox: { uidValidity: 100, uidNext: 10, exists: 0 } as {
    uidValidity: number;
    uidNext: number;
    exists: number;
  },
  messages: [] as { uid: number; flags: Set<string>; subject: string }[],
  failConnect: false,
}));

vi.mock('imapflow', () => {
  class ImapFlow {
    mailbox: unknown = undefined;
    constructor(_o: unknown) {}
    connect(): Promise<void> {
      if (h.failConnect) return Promise.reject(new Error('IMAP connect failed'));
      return Promise.resolve();
    }
    logout(): Promise<void> {
      return Promise.resolve();
    }
    list() {
      return Promise.resolve([
        {
          path: 'INBOX',
          name: 'INBOX',
          delimiter: '/',
          parentPath: '',
          flags: new Set<string>(),
          specialUse: '\\Inbox',
        },
      ]);
    }
    getMailboxLock(): Promise<{ release: () => void }> {
      this.mailbox = h.mailbox;
      return Promise.resolve({ release: () => undefined });
    }
    fetch(range: string, query: { envelope?: boolean }) {
      const full = query.envelope === true;
      const uids = full ? range.split(',').map(Number) : h.messages.map((m) => m.uid);
      const selected = h.messages.filter((m) => uids.includes(m.uid));
      return (async function* () {
        for (const m of selected) {
          yield {
            uid: m.uid,
            flags: m.flags,
            size: 100,
            envelope: full
              ? { subject: m.subject, from: [{ address: 'a@b.com', name: 'A' }], date: new Date() }
              : undefined,
            internalDate: new Date(),
          };
        }
      })();
    }
  }
  return { ImapFlow };
});

vi.mock('nodemailer', () => ({ default: { createTransport: () => ({}) } }));

import {
  setupTestDb,
  teardownTestDb,
  resetState,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import { syncAccount, syncStaleAccounts, withAccountLock } from '../account-sync.js';
import { Account } from '../../models/Account.js';
import { redis } from '../../config/redis.js';

describe('account-sync (sync IMAP de fondo)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
    h.mailbox = { uidValidity: 100, uidNext: 10, exists: 0 };
    h.messages = [{ uid: 1, flags: new Set(), subject: 'nuevo' }];
    h.failConnect = false;
  });

  it('sincroniza una cuenta y deja status=active + lastSyncedAt; libera el lock', async () => {
    const { account } = await seedUserWithAccount({ email: 'bg@test.com' });
    const r = await syncAccount(account);
    expect(r.skipped).toBeUndefined();

    const after = await Account.findById(account._id);
    expect(after?.status).toBe('active');
    expect(after?.lastSyncedAt).toBeInstanceOf(Date);
    expect(after?.lastError ?? '').toBe('');
    // El lock se liberó (otro sync no queda bloqueado).
    expect(await redis.get(`sync:account:${account._id.toString()}`)).toBeNull();
  });

  it('lock distribuido: si otra instancia tiene el lock, syncAccount se SALTA', async () => {
    const { account } = await seedUserWithAccount({ email: 'lock@test.com' });
    // Simula que OTRA instancia ya tomó el lock.
    await redis.set(`sync:account:${account._id.toString()}`, '1', 'EX', 300, 'NX');
    const r = await syncAccount(account);
    expect(r.skipped).toBe(true);
    expect(r.synced).toBe(0);
  });

  it('error de IMAP → status=error + lastError, y el lock se libera igual (finally)', async () => {
    const { account } = await seedUserWithAccount({ email: 'err@test.com' });
    h.failConnect = true;
    await expect(syncAccount(account)).rejects.toThrow();

    const after = await Account.findById(account._id);
    expect(after?.status).toBe('error');
    expect(after?.lastError).toContain('IMAP');
    expect(await redis.get(`sync:account:${account._id.toString()}`)).toBeNull(); // liberado
  });

  it('release ATÓMICO: no borra el lock si OTRA instancia lo tomó tras una expiración (token)', async () => {
    const key = 'sync:account:fake-id';
    // Simula: durante nuestro fn, el TTL expira y OTRA instancia toma el lock (token distinto).
    const r = await withAccountLock('fake-id', async () => {
      await redis.set(key, 'foreign-instance-token'); // pisa nuestro token
      return 1;
    });
    expect(r.skipped).toBe(false);
    // Nuestro release (Lua compare-and-del) NO debe haber borrado el lock ajeno.
    expect(await redis.get(key)).toBe('foreign-instance-token');
    await redis.del(key);
  });

  it('withAccountLock se SALTA si el lock está tomado y NO lo borra al salir', async () => {
    const key = 'sync:account:held';
    await redis.set(key, 'someone-else', 'EX', 300, 'NX');
    const r = await withAccountLock('held', async () => 42);
    expect(r.skipped).toBe(true);
    expect(await redis.get(key)).toBe('someone-else'); // intacto
    await redis.del(key);
  });

  it('syncStaleAccounts: sincroniza las cuentas no deshabilitadas; salta las disabled', async () => {
    const a1 = await seedUserWithAccount({ email: 'a1@test.com' });
    const a2 = await seedUserWithAccount({ email: 'a2@test.com' });
    const a3 = await seedUserWithAccount({ email: 'a3@test.com' });
    await Account.updateOne({ _id: a3.account._id }, { status: 'disabled' });

    const r = await syncStaleAccounts();
    expect(r.accounts).toBe(2); // a1 y a2, NO la disabled

    expect((await Account.findById(a1.account._id))?.status).toBe('active');
    expect((await Account.findById(a2.account._id))?.status).toBe('active');
    expect((await Account.findById(a3.account._id))?.status).toBe('disabled'); // intacta
  });
});
