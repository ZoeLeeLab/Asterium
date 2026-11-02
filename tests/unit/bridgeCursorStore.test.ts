import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BridgeCursorStore } from '../../src/main/security/BridgeCursorStore';

describe('BridgeCursorStore', () => {
  it('persists only opaque replay cursors', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-bridge-cursor-'));
    try {
      const file = path.join(directory, 'cursor.json');
      const store = new BridgeCursorStore(file);
      await store.set('partner:thread', '42');
      expect(await new BridgeCursorStore(file).get('partner:thread')).toBe('42');
      expect(await readFile(file, 'utf8')).not.toContain('secret');
      await store.delete('partner:thread');
      expect(await store.get('partner:thread')).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
