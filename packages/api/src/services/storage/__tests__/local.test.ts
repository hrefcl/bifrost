import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { LocalStorage } from '../local.js';
import { newStorageKey } from '../types.js';

const root = path.join(tmpdir(), `bifrost-storage-test-${randomUUID()}`);
const store = new LocalStorage(root);

describe('LocalStorage', () => {
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('put → get devuelve los mismos bytes', async () => {
    const key = newStorageKey();
    const data = Buffer.from('hola adjunto 📎', 'utf-8');
    await store.put(key, data);
    expect(await store.get(key)).toEqual(data);
  });

  it('delete es idempotente y deja get sin archivo', async () => {
    const key = newStorageKey();
    await store.put(key, Buffer.from('x'));
    await store.delete(key);
    await store.delete(key); // segunda vez no falla
    await expect(store.get(key)).rejects.toThrow();
  });

  it('RECHAZA path traversal en la key (no escapa del root)', async () => {
    await expect(store.get('../../../etc/passwd')).rejects.toThrow(/path traversal/i);
    await expect(store.put('../escape', Buffer.from('x'))).rejects.toThrow(/path traversal/i);
    await expect(store.delete('../../etc/x')).rejects.toThrow(/path traversal/i);
  });

  it('RECHAZA keys que apuntan al propio root (vacía, ".", "..", subidas normalizadas)', async () => {
    for (const bad of ['', '.', '..', 'foo/..', 'foo/.', 'foo/../..']) {
      await expect(store.get(bad), `get(${JSON.stringify(bad)})`).rejects.toThrow(
        /Invalid storage key/i
      );
      await expect(store.put(bad, Buffer.from('x')), `put(${JSON.stringify(bad)})`).rejects.toThrow(
        /Invalid storage key/i
      );
      await expect(store.delete(bad), `delete(${JSON.stringify(bad)})`).rejects.toThrow(
        /Invalid storage key/i
      );
    }
  });

  it('newStorageKey genera keys únicas (uuid)', () => {
    expect(newStorageKey()).not.toBe(newStorageKey());
  });
});
