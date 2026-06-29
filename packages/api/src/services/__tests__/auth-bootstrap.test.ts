import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// IMAP siempre válido → loginOrRegister upsertea el usuario sin tocar la red.
vi.mock('imapflow', () => {
  class ImapFlow {
    constructor(_o: unknown) {}
    connect(): Promise<void> {
      return Promise.resolve();
    }
    logout(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ImapFlow };
});

import { setupTestDb, teardownTestDb, resetState } from '../../../test/integration-helper.js';
import { loginOrRegister } from '../auth.js';
import { User } from '../../models/User.js';

const creds = (email: string) => ({
  email,
  password: 'x',
  displayName: '',
  imapHost: 'mail.test',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'mail.test',
  smtpPort: 465,
  smtpSecure: true,
});

describe('bootstrap admin: el primer usuario que se autentica queda admin', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('1er login (sin admin en el sistema) → role admin; 2do login → role user', async () => {
    const first = await loginOrRegister(creds('boss@aulion.app'));
    expect(first.isNew).toBe(true);
    expect(first.user.role).toBe('admin');

    const second = await loginOrRegister(creds('staff@aulion.app'));
    expect(second.isNew).toBe(true);
    expect(second.user.role).toBe('user');

    // Sólo un admin en el sistema.
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
  });

  it('auto-cura: si el único usuario quedó como user (sin admin), su próximo login lo promueve', async () => {
    // Simula el caso aulion: usuario creado por login directo, sin admin en el sistema.
    await User.create({ primaryEmail: 'legacy@aulion.app', displayName: 'legacy', role: 'user' });
    expect(await User.exists({ role: 'admin' })).toBeFalsy();

    const again = await loginOrRegister(creds('legacy@aulion.app'));
    expect(again.isNew).toBe(false);
    expect(again.user.role).toBe('admin');
  });
});
