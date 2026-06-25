import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Fuerza SYNC_WINDOW pequeño ANTES de importar imap.js (hoisted corre antes de los imports)
// para ejercitar el camino multi-lote del sync por ventanas (anti-OOM, TD-SYNC-OOM).
const h = vi.hoisted(() => {
  process.env.SYNC_WINDOW = '2';
  return {
    mailbox: { uidValidity: 100, uidNext: 100, exists: 0 } as {
      uidValidity: number;
      uidNext: number;
      exists: number;
    },
    messages: [] as { uid: number; flags: Set<string>; subject: string }[],
    lightScans: 0, // cuántos fetch '1:*' (scan liviano) se hicieron
  };
});

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
      return Promise.resolve({ release: () => undefined });
    }
    fetch(range: string, query: { envelope?: boolean }) {
      const full = query.envelope === true;
      if (!full) h.lightScans++;
      // El scan liviano ('1:*') devuelve TODOS los mensajes en orden ascendente de UID
      // (como un servidor IMAP real); el fetch completo, sólo los UID pedidos.
      const uids = full ? range.split(',').map(Number) : h.messages.map((m) => m.uid);
      // El scan liviano emite en el ORDEN de h.messages (no reordena): así un test puede
      // simular un servidor que responde UIDs fuera de orden (RFC 9051 lo permite) y verificar
      // que la reconciliación no depende del orden de llegada.
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

describe('syncFolderHeaders por ventanas (TD-SYNC-OOM, SYNC_WINDOW=2)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
    h.mailbox = { uidValidity: 100, uidNext: 100, exists: 0 };
    h.messages = [];
    h.lightScans = 0;
  });

  it('5 mensajes con ventana de 2 → varios lotes, todos insertados, un solo scan liviano', async () => {
    const { account } = await seedUserWithAccount({ email: 'batch@test.com' });
    const folder = await seedFolder(account._id);
    const fid = folder._id.toString();

    h.messages = [1, 2, 3, 4, 5].map((uid) => ({
      uid,
      flags: uid % 2 === 0 ? new Set(['\\Seen']) : new Set<string>(),
      subject: `msg-${String(uid)}`,
    }));
    const inserted = await syncFolderHeaders(account, fid);

    expect(inserted).toBe(5);
    expect(await Email.countDocuments({ folderId: fid })).toBe(5);
    // El stream '1:*' se recorre UNA sola vez aunque haya múltiples lotes (no re-escanea).
    expect(h.lightScans).toBe(1);
    const f = await Folder.findById(fid);
    expect(f?.totalMessages).toBe(5);
    expect(f?.unseenMessages).toBe(3); // uid 1,3,5 no leídos
  });

  it('expunge en el BORDE entre lotes + flags cross-batch + nuevo al final', async () => {
    const { account } = await seedUserWithAccount({ email: 'edge@test.com' });
    const folder = await seedFolder(account._id);
    const fid = folder._id.toString();

    // Corrida 1: uid 1..5.
    h.messages = [1, 2, 3, 4, 5].map((uid) => ({
      uid,
      flags: new Set<string>(),
      subject: `m${String(uid)}`,
    }));
    await syncFolderHeaders(account, fid);
    expect(await Email.countDocuments({ folderId: fid })).toBe(5);

    // Corrida 2: uid3 expunged (cae en el lote [3,4]), uid1 ahora leído (lote [1,2]),
    // uid5 leído (lote [5]), uid6 nuevo (lote final). Cruza varios límites de ventana.
    h.messages = [
      { uid: 1, flags: new Set(['\\Seen']), subject: 'm1' },
      { uid: 2, flags: new Set<string>(), subject: 'm2' },
      { uid: 4, flags: new Set<string>(), subject: 'm4' },
      { uid: 5, flags: new Set(['\\Seen']), subject: 'm5' },
      { uid: 6, flags: new Set<string>(), subject: 'm6' },
    ];
    const inserted2 = await syncFolderHeaders(account, fid);

    expect(inserted2).toBe(1); // sólo uid6
    const uids = (await Email.find({ folderId: fid }).select('uid').lean())
      .map((e) => e.uid)
      .sort((a, b) => a - b);
    expect(uids).toEqual([1, 2, 4, 5, 6]); // uid3 borrado
    expect((await Email.findOne({ folderId: fid, uid: 1 }))?.flags.seen).toBe(true);
    expect((await Email.findOne({ folderId: fid, uid: 5 }))?.flags.seen).toBe(true);
    const f = await Folder.findById(fid);
    expect(f?.totalMessages).toBe(5);
    expect(f?.unseenMessages).toBe(3); // uid 2,4,6
  });

  it('UIDs fuera de orden (RFC 9051) → new/expunge/flags correctos sin asumir monotonía', async () => {
    const { account } = await seedUserWithAccount({ email: 'unordered@test.com' });
    const folder = await seedFolder(account._id);
    const fid = folder._id.toString();

    // Corrida 1 (orden desordenado a propósito): 1..6.
    h.messages = [4, 1, 6, 2, 5, 3].map((uid) => ({
      uid,
      flags: new Set<string>(),
      subject: `m${String(uid)}`,
    }));
    await syncFolderHeaders(account, fid);
    expect(await Email.countDocuments({ folderId: fid })).toBe(6);

    // Corrida 2 desordenada: uid3 y uid4 expunged, uid2 leído, uid7 nuevo. El orden de
    // llegada (5,7,1,2,6) no debe afectar qué se borra/inserta/actualiza.
    h.messages = [
      { uid: 5, flags: new Set<string>(), subject: 'm5' },
      { uid: 7, flags: new Set<string>(), subject: 'm7' },
      { uid: 1, flags: new Set<string>(), subject: 'm1' },
      { uid: 2, flags: new Set(['\\Seen']), subject: 'm2' },
      { uid: 6, flags: new Set<string>(), subject: 'm6' },
    ];
    const inserted = await syncFolderHeaders(account, fid);
    expect(inserted).toBe(1); // sólo uid7
    const uids = (await Email.find({ folderId: fid }).select('uid').lean())
      .map((e) => e.uid)
      .sort((a, b) => a - b);
    expect(uids).toEqual([1, 2, 5, 6, 7]); // uid3 y uid4 borrados
    expect((await Email.findOne({ folderId: fid, uid: 2 }))?.flags.seen).toBe(true);
  });

  it('servidor sin uidNext → barre expunged por encima del último UID (rango "infinito")', async () => {
    const { account } = await seedUserWithAccount({ email: 'nouidnext@test.com' });
    const folder = await seedFolder(account._id);
    const fid = folder._id.toString();

    h.messages = [1, 2, 3, 4].map((uid) => ({
      uid,
      flags: new Set<string>(),
      subject: `m${String(uid)}`,
    }));
    await syncFolderHeaders(account, fid);
    expect(await Email.countDocuments({ folderId: fid })).toBe(4);

    // El servidor deja sólo uid1; uidNext=0 (no expuesto). uid 2,3,4 deben borrarse aunque
    // queden por encima del último UID listado y no haya cota uidNext.
    h.mailbox = { uidValidity: 100, uidNext: 0, exists: 1 };
    h.messages = [{ uid: 1, flags: new Set<string>(), subject: 'm1' }];
    await syncFolderHeaders(account, fid);

    const uids = (await Email.find({ folderId: fid }).select('uid').lean()).map((e) => e.uid);
    expect(uids).toEqual([1]);
    const f = await Folder.findById(fid);
    expect(f?.totalMessages).toBe(1);
  });
});
