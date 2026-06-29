import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, resetState } from '../../../test/integration-helper.js';
import { computeThreadId, parseReferences } from '../threading.js';
import { Email } from '../../models/Email.js';
import mongoose from 'mongoose';

const ACC = new mongoose.Types.ObjectId().toString();
let uid = 0;

// Simula la ingesta de un email: calcula su threadId (como hace upsertMessage) y lo persiste.
async function ingest(messageId: string, inReplyTo: string | undefined, references: string[]) {
  const threadId = await computeThreadId(ACC, messageId, inReplyTo, references);
  await Email.create({
    accountId: ACC,
    folderId: new mongoose.Types.ObjectId().toString(),
    uid: ++uid,
    messageId,
    inReplyTo,
    references,
    threadId,
    from: { address: 'x@test.com' },
    to: [],
    subject: 'Re: hilo',
    date: new Date().toISOString(),
    internalDate: new Date().toISOString(),
    size: 1,
    flags: { seen: false, answered: false, flagged: false, deleted: false, draft: false },
  });
  return threadId;
}
const tid = async (mid: string) =>
  (await Email.findOne({ accountId: ACC, messageId: mid }).lean())?.threadId;

const A = '<root@amazonses.com>';
const G2 = '<g2@mail.gmail.com>';
const G3 = '<g3@mail.gmail.com>';
const G1 = '<g1@mail.gmail.com>';
const SESB = '<sesb@amazonses.com>';

describe('threading: union-find por conversación', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
    uid = 0;
  });

  it('parseReferences extrae los <message-id> del header crudo', () => {
    expect(parseReferences('<a@x> <b@y>\r\n <c@z>')).toEqual(['<a@x>', '<b@y>', '<c@z>']);
    expect(parseReferences(undefined)).toEqual([]);
    expect(parseReferences('References: <a@x>')).toEqual(['<a@x>']);
  });

  it('los 3 .eml reales se agrupan en UN hilo (incl. 1.eml que cuelga de G2, no de A)', async () => {
    await ingest(A, undefined, []); // raíz (enviado por SES) → threadId = A
    await ingest(G2, A, [A]); // 2.eml → adopta A
    await ingest(G3, A, [A]); // 3.eml → adopta A
    await ingest(G1, SESB, [G2]); // 1.eml → refs[0]=G2 (no A); adopta A vía G2

    const t = await tid(A);
    expect(await tid(G2)).toBe(t);
    expect(await tid(G3)).toBe(t);
    expect(await tid(G1)).toBe(t); // el caso que un threadId=references[0] ingenuo dejaba afuera
    expect(new Set([await tid(A), await tid(G2), await tid(G3), await tid(G1)]).size).toBe(1);
  });

  it('orden de llegada arbitrario: un orphan se re-linkea cuando llega su ancestro', async () => {
    await ingest(G1, SESB, [G2]); // llega 1.eml ANTES que su parent G2 → hilo provisional
    expect(await tid(G1)).toBe(G2); // raíz natural provisional = references[0] = G2

    await ingest(A, undefined, []);
    await ingest(G2, A, [A]); // ahora llega G2 → conecta G1 (lo referencia) y A → MERGE

    const t = await tid(A);
    expect(await tid(G2)).toBe(t);
    expect(await tid(G1)).toBe(t); // el orphan quedó re-linkeado al hilo de A
  });

  it('hilos distintos no se mezclan', async () => {
    await ingest('<m1@x>', undefined, []);
    await ingest('<m2@x>', undefined, []);
    expect(await tid('<m1@x>')).not.toBe(await tid('<m2@x>'));
  });
});
