import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestUpdate, getUpdateState, isUpdateInProgress } from '../update-apply.js';

let dir: string;

describe('update-apply (marker del host-updater)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'upd-'));
    process.env.UPDATE_TRIGGER_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.UPDATE_TRIGGER_DIR;
  });

  it('requestUpdate escribe el marker `requested` con sha-<sha> (atómico)', () => {
    const tag = requestUpdate('5911761');
    expect(tag).toBe('sha-5911761');
    const marker = join(dir, 'requested');
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8').trim()).toBe('sha-5911761');
    expect(existsSync(`${marker}.tmp`)).toBe(false); // el rename atómico consumió el .tmp
  });

  it('rechaza un sha inválido (no inyección de tag arbitrario)', () => {
    for (const bad of ['latest', '../evil', 'sha; rm -rf /', 'ABC123', '']) {
      expect(() => requestUpdate(bad)).toThrow(/sha inválido/);
    }
    expect(existsSync(join(dir, 'requested'))).toBe(false);
  });

  it('getUpdateState lee el state.json del host-updater; idle si no hay', () => {
    expect(getUpdateState()).toEqual({ status: 'idle' });
    expect(isUpdateInProgress()).toBe(false);
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ status: 'in_progress', to: 'sha-x' }));
    expect(getUpdateState().status).toBe('in_progress');
    expect(isUpdateInProgress()).toBe(true);
  });

  it('state.json corrupto → idle (no rompe)', () => {
    writeFileSync(join(dir, 'state.json'), 'no-json{');
    expect(getUpdateState()).toEqual({ status: 'idle' });
  });
});
