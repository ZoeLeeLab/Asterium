// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone build helper.
import { prepareSourceMaterials } from '../../scripts/prepare-source-materials.mjs';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'asterium-source-materials-'));
  const projectRoot = path.join(base, 'synthetic-source');
  const cacheDirectory = path.join(base, 'synthetic-cache');
  const destination = path.join(base, 'output');
  fs.mkdirSync(path.join(projectRoot, 'third_party/licenses'), { recursive: true });
  fs.mkdirSync(cacheDirectory);
  const bytes = Buffer.from('Synthetic public source; never a real vendor archive.');
  const entry = { id: 'synthetic component', file: 'synthetic-source.txt', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.invalid/source' };
  const manifest = { schemaVersion: 1, archives: [entry] };
  fs.writeFileSync(path.join(projectRoot, 'third_party/licenses/source-archives.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'), 'Synthetic notice.');
  fs.writeFileSync(path.join(cacheDirectory, entry.file), bytes);
  return { projectRoot, cacheDirectory, destination, manifest, bytes };
}

describe('Corresponding-source material integrity', () => {
  it('copies only reviewed inputs and preserves their exact bytes and relative notices', () => {
    const state = fixture();
    fs.writeFileSync(path.join(state.cacheDirectory, 'unlisted-private-fixture.txt'), 'synthetic content that must not be copied');
    const receipt = prepareSourceMaterials(state);
    expect(receipt.archives).toHaveLength(1);
    expect(fs.readFileSync(path.join(state.destination, 'synthetic-source.txt')).equals(state.bytes)).toBe(true);
    expect(fs.existsSync(path.join(state.destination, 'unlisted-private-fixture.txt'))).toBe(false);
    expect(fs.existsSync(path.join(state.destination, 'third_party/licenses/source-archives.json'))).toBe(true);
  });
  it('refuses altered source bytes before creating output', () => {
    const state = fixture();
    fs.appendFileSync(path.join(state.cacheDirectory, 'synthetic-source.txt'), 'tampered');
    expect(() => prepareSourceMaterials(state)).toThrow('Source archive hash mismatch');
    expect(fs.existsSync(state.destination)).toBe(false);
  });
  it('does not overwrite an existing delivery directory', () => {
    const state = fixture();
    fs.mkdirSync(state.destination);
    fs.writeFileSync(path.join(state.destination, 'sentinel'), 'preserve');
    expect(() => prepareSourceMaterials(state)).toThrow('fresh source-material');
    expect(fs.readFileSync(path.join(state.destination, 'sentinel'), 'utf8')).toBe('preserve');
  });
  it('rejects source-manifest traversal without reading outside the cache', () => {
    const state = fixture();
    state.manifest.archives[0].file = '../outside.txt';
    fs.writeFileSync(path.join(state.projectRoot, 'third_party/licenses/source-archives.json'), JSON.stringify(state.manifest));
    expect(() => prepareSourceMaterials(state)).toThrow('Invalid reviewed source manifest');
    expect(fs.existsSync(state.destination)).toBe(false);
  });
});
