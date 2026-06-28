import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyState,
  addResource,
  removeResource,
  hasResource,
  serializeState,
  parseState,
  saveState,
  loadState,
  type ProvisionState,
} from '../state.js';

describe('ProvisionState', () => {
  it('addResource dedup por kind+id e inmutabilidad', () => {
    const s0 = emptyState('us-east-1', 'example.com');
    const s1 = addResource(s0, { kind: 'ec2-instance', id: 'i-123' });
    const s2 = addResource(s1, { kind: 'ec2-instance', id: 'i-123', meta: { x: 'y' } });
    expect(s0.resources).toHaveLength(0); // s0 intacto (inmutable)
    expect(s2.resources).toHaveLength(1); // dedup
    expect(s2.resources[0]?.meta).toEqual({ x: 'y' });
  });

  it('removeResource y hasResource', () => {
    let s = emptyState('us-east-1', 'example.com');
    s = addResource(s, { kind: 's3-bucket', id: 'b1' });
    expect(hasResource(s, 's3-bucket')).toBe(true);
    expect(hasResource(s, 's3-bucket', 'b1')).toBe(true);
    s = removeResource(s, 's3-bucket', 'b1');
    expect(hasResource(s, 's3-bucket')).toBe(false);
  });

  it('serialize→parse round-trip', () => {
    let s = emptyState('eu-west-1', 'acme.io');
    s = addResource(s, { kind: 'kms-key', id: 'arn:key', region: 'eu-west-1' });
    s = addResource(s, { kind: 'route53-zone', id: 'Z1', meta: { createdByUs: 'true' } });
    const back = parseState(serializeState(s));
    expect(back).toEqual(s);
  });

  it('parseState rechaza corrupto (versión, kind, no-objeto)', () => {
    expect(() => parseState('123')).toThrow(/no es un objeto/);
    expect(() => parseState(JSON.stringify({ version: 2 }))).toThrow(/versión/);
    expect(() =>
      parseState(
        JSON.stringify({
          version: 1,
          region: 'x',
          domain: 'y',
          resources: [{ kind: 'nope', id: 'a' }],
        })
      )
    ).toThrow(/kind inválido/);
  });

  it('saveState/loadState round-trip real en disco; loadState null si no existe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bifrost-state-'));
    const path = join(dir, 'state.json');
    expect(loadState(path)).toBeNull();
    const s: ProvisionState = addResource(emptyState('us-east-1', 'example.com'), {
      kind: 'elastic-ip',
      id: 'eipalloc-1',
    });
    saveState(path, s);
    expect(readFileSync(path, 'utf8')).toContain('eipalloc-1');
    expect(loadState(path)).toEqual(s);
  });
});
