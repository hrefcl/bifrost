import { describe, it, expect } from 'vitest';
import { resolveSesCommand, explainState, SES_COMMANDS } from '../ses/commands.js';
import type { OutboundState } from '../aws/ses-identity.js';

describe('resolveSesCommand (dispatcher puro)', () => {
  it('reconoce cada subcomando SES en argv[2]', () => {
    for (const cmd of SES_COMMANDS) {
      expect(resolveSesCommand(['node', 'cli', cmd])).toBe(cmd);
    }
  });

  it('devuelve null para no-comandos (main/destroy/desconocido)', () => {
    expect(resolveSesCommand(['node', 'cli'])).toBeNull();
    expect(resolveSesCommand(['node', 'cli', 'destroy'])).toBeNull();
    expect(resolveSesCommand(['node', 'cli', 'ses-nope'])).toBeNull();
  });
});

describe('explainState', () => {
  it('cubre todos los estados con un mensaje accionable', () => {
    const states: OutboundState[] = [
      'pending-dkim',
      'failed-dkim',
      'pending-mail-from',
      'failed-mail-from',
      'pending-production-access',
      'ready',
    ];
    for (const s of states) {
      expect(explainState(s).length).toBeGreaterThan(0);
    }
    // El honesto sobre sandbox menciona el límite y el paso manual.
    expect(explainState('pending-production-access')).toMatch(/sandbox/i);
    expect(explainState('ready')).toMatch(/listo/i);
  });
});
