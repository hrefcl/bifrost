import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, resetState } from '../../../test/integration-helper.js';
import {
  createProvisionKey,
  listProvisionKeys,
  revokeProvisionKey,
  verifyProvisionKey,
  hasActiveProvisionKey,
} from '../provision-keys.js';
import { ProvisionApiKey } from '../../models/ProvisionApiKey.js';

describe('provision-keys', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('create devuelve el token en claro UNA vez y en Mongo sólo guarda el hash', async () => {
    const { token, key } = await createProvisionKey('Vanir', 'admin:1');
    expect(token.startsWith('bfp_')).toBe(true);
    expect(token.length).toBeGreaterThan(20);
    expect(key.label).toBe('Vanir');
    expect(key.active).toBe(true);

    const doc = await ProvisionApiKey.findOne({ _id: key.id }).lean();
    // El token en claro NO está en ningún campo persistido.
    expect(JSON.stringify(doc)).not.toContain(token);
    expect(doc?.tokenHash).toBeTruthy();
    expect(doc?.tokenHash).not.toBe(token);
  });

  it('verify acepta el token correcto, sella lastUsedAt y rechaza uno inválido', async () => {
    const { token } = await createProvisionKey('k', 'admin:1');
    expect(await verifyProvisionKey(token)).toBe(true);
    expect(await verifyProvisionKey('bfp_no-existe')).toBe(false);
    expect(await verifyProvisionKey('')).toBe(false);

    const list = await listProvisionKeys();
    expect(list[0].lastUsedAt).not.toBeNull();
  });

  it('revoke desactiva la key: verify pasa a false y active=false', async () => {
    const { token, key } = await createProvisionKey('k', 'admin:1');
    expect(await verifyProvisionKey(token)).toBe(true);
    expect(await revokeProvisionKey(key.id)).toBe(true);
    expect(await verifyProvisionKey(token)).toBe(false);

    const list = await listProvisionKeys();
    expect(list[0].active).toBe(false);
    expect(list[0].revokedAt).not.toBeNull();
  });

  it('revoke es idempotente y devuelve false para un id inexistente', async () => {
    const { key } = await createProvisionKey('k', 'admin:1');
    expect(await revokeProvisionKey(key.id)).toBe(true);
    expect(await revokeProvisionKey(key.id)).toBe(true); // ya revocada → sigue true
    expect(await revokeProvisionKey('64b7f0000000000000000000')).toBe(false);
  });

  it('hasActiveProvisionKey refleja sólo keys no revocadas', async () => {
    expect(await hasActiveProvisionKey()).toBe(false);
    const { key } = await createProvisionKey('k', 'admin:1');
    expect(await hasActiveProvisionKey()).toBe(true);
    await revokeProvisionKey(key.id);
    expect(await hasActiveProvisionKey()).toBe(false);
  });

  it('list no expone hash ni token, más nuevas primero', async () => {
    await createProvisionKey('primera', 'admin:1');
    await createProvisionKey('segunda', 'admin:1');
    const list = await listProvisionKeys();
    expect(list.map((k) => k.label)).toEqual(['segunda', 'primera']);
    expect(JSON.stringify(list)).not.toContain('tokenHash');
    expect(list[0].prefix.startsWith('bfp_')).toBe(true);
  });
});
