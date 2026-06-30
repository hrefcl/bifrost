import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Estado mutable del "servidor IMAP" simulado (hoisted para usarlo en mock + test).
const h = vi.hoisted(() => ({
  mailbox: { uidValidity: 100, uidNext: 10, exists: 0 } as {
    uidValidity: number;
    uidNext: number;
    exists: number;
  },
  messages: [] as { uid: number; flags: Set<string>; subject: string }[],
  active: 0, // sincronizaciones activas en este instante (para test de mutex)
  maxActive: 0,
}));

vi.mock('imapflow', () => {
  class ImapFlow {
    mailbox: unknown = undefined;
    constructor(_o: unknown) {}
    connect(): Promise<void> {
      return Promise.resolve();
    }
    logout(): Promise<void> {
      return Promise.resolve();
    }
    getMailboxLock(): Promise<{ release: () => void }> {
      this.mailbox = h.mailbox;
      h.active++;
      h.maxActive = Math.max(h.maxActive, h.active);
      return Promise.resolve({
        release: () => {
          h.active--;
        },
      });
    }
    fetch(range: string, query: { envelope?: boolean }) {
      const full = query.envelope === true;
      const uids = full ? range.split(',').map(Number) : h.messages.map((m) => m.uid);
      const selected = h.messages.filter((m) => uids.includes(m.uid));
      return (async function* () {
        for (const m of selected) {
          if (full) {
            yield {
              uid: m.uid,
              flags: m.flags,
              size: 100,
              internalDate: new Date('2026-01-01T00:00:00Z'),
              envelope: {
                from: [{ address: 'a@test', name: 'A' }],
                to: [{ address: 'me@test' }],
                subject: m.subject,
                date: '2026-01-01T00:00:00Z',
                messageId: `<${String(m.uid)}@test>`,
              },
              bodyStructure: undefined,
            };
          } else {
            yield { uid: m.uid, flags: m.flags };
          }
        }
      })();
    }
    fetchOne(): Promise<false> {
      return Promise.resolve(false);
    }
  }
  return { ImapFlow };
});

import {
  setupTestDb,
  teardownTestDb,
  resetState,
  seedUserWithAccount,
  seedFolder,
} from '../../../test/integration-helper.js';
import { syncFolderHeaders } from '../imap.js';
import { Email } from '../../models/Email.js';
import { Folder } from '../../models/Folder.js';

describe('syncFolderHeaders incremental (F3.4)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
    h.mailbox = { uidValidity: 100, uidNext: 10, exists: 0 };
    h.messages = [];
    h.active = 0;
    h.maxActive = 0;
  });

  it('sincroniza nuevos, expunged y flags entre corridas; respeta UIDVALIDITY', async () => {
    const { account } = await seedUserWithAccount({ email: 'sync@test.com' });
    const folder = await seedFolder(account._id);
    const fid = folder._id.toString();

    // Corrida 1: 2 mensajes (uid1 leído, uid2 no leído).
    h.messages = [
      { uid: 1, flags: new Set(['\\Seen']), subject: 'one' },
      { uid: 2, flags: new Set(), subject: 'two' },
    ];
    const inserted1 = await syncFolderHeaders(account, fid);
    expect(inserted1).toBe(2);
    expect(await Email.countDocuments({ folderId: fid })).toBe(2);
    let f = await Folder.findById(fid);
    expect(f?.uidValidity).toBe(100);
    expect(f?.totalMessages).toBe(2);
    expect(f?.unseenMessages).toBe(1);

    // Corrida 2: uid1 expunged, uid2 ahora leído, uid3 nuevo.
    h.messages = [
      { uid: 2, flags: new Set(['\\Seen']), subject: 'two' },
      { uid: 3, flags: new Set(), subject: 'three' },
    ];
    const inserted2 = await syncFolderHeaders(account, fid);
    expect(inserted2).toBe(1); // sólo uid3 es nuevo
    const uids = (await Email.find({ folderId: fid }).select('uid flags').lean())
      .map((e) => e.uid)
      .sort((a, b) => a - b);
    expect(uids).toEqual([2, 3]); // uid1 borrado
    const e2 = await Email.findOne({ folderId: fid, uid: 2 });
    expect(e2?.flags.seen).toBe(true); // flag actualizado
    f = await Folder.findById(fid);
    expect(f?.totalMessages).toBe(2);
    expect(f?.unseenMessages).toBe(1);

    // Corrida 3: cambia UIDVALIDITY → wipe + resync.
    h.mailbox = { uidValidity: 999, uidNext: 5, exists: 1 };
    h.messages = [{ uid: 1, flags: new Set(), subject: 'fresh' }];
    await syncFolderHeaders(account, fid);
    expect(await Email.countDocuments({ folderId: fid })).toBe(1);
    const fresh = await Email.findOne({ folderId: fid });
    expect(fresh?.subject).toBe('fresh');
    f = await Folder.findById(fid);
    expect(f?.uidValidity).toBe(999);
  });

  it('mailbox vacío → 0 mensajes, borra DB local y deja contadores en 0', async () => {
    const { account } = await seedUserWithAccount({ email: 'empty@test.com' });
    const folder = await seedFolder(account._id);
    const fid = folder._id.toString();
    // Sembrar 1 mensaje y luego vaciar el servidor.
    h.messages = [{ uid: 1, flags: new Set(), subject: 'x' }];
    await syncFolderHeaders(account, fid);
    expect(await Email.countDocuments({ folderId: fid })).toBe(1);
    h.messages = [];
    await syncFolderHeaders(account, fid);
    expect(await Email.countDocuments({ folderId: fid })).toBe(0);
    const f = await Folder.findById(fid);
    expect(f?.totalMessages).toBe(0);
    expect(f?.unseenMessages).toBe(0);
  });

  it('dos syncs concurrentes del mismo folder se serializan (mutex, sin duplicar)', async () => {
    const { account } = await seedUserWithAccount({ email: 'conc@test.com' });
    const folder = await seedFolder(account._id);
    const fid = folder._id.toString();
    h.messages = [
      { uid: 1, flags: new Set(), subject: 'a' },
      { uid: 2, flags: new Set(), subject: 'b' },
    ];
    await Promise.all([syncFolderHeaders(account, fid), syncFolderHeaders(account, fid)]);
    // Mutex: nunca hubo 2 syncs activos a la vez sobre el folder.
    expect(h.maxActive).toBe(1);
    // Sin duplicados (índice único + serialización).
    expect(await Email.countDocuments({ folderId: fid })).toBe(2);
  });

  it('backfill: un email existente SIN threadId se re-threadea en el próximo sync (no cuenta como nuevo)', async () => {
    const { account } = await seedUserWithAccount({ email: 'backfill@test.com' });
    const folder = await seedFolder(account._id);
    const fid = folder._id.toString();
    h.messages = [{ uid: 7, flags: new Set(), subject: 'hilo' }];
    await syncFolderHeaders(account, fid); // inserta uid7 con threadId calculado
    // Simula un email guardado ANTES de la feature: sin threadId.
    await Email.updateOne(
      { accountId: account._id.toString(), uid: 7 },
      { $unset: { threadId: 1, references: 1 } }
    );
    expect((await Email.findOne({ folderId: fid, uid: 7 }).lean())?.threadId).toBeUndefined();

    // Próximo sync: el backfill lo re-fetchea y le calcula el threadId. NO se cuenta como nuevo.
    const inserted = await syncFolderHeaders(account, fid);
    expect(inserted).toBe(0); // backfill no es "correo nuevo"
    const after = await Email.findOne({ folderId: fid, uid: 7 }).lean();
    expect(after?.threadId).toBe('<7@test>'); // del messageId del envelope mock
  });
});
