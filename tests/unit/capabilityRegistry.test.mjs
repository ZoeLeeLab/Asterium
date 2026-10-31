// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validateEntry, checkCapabilities } from '../../scripts/check-capabilities.mjs';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const base = { name: '能力', id: 'asterium.test', appliesTo: ['api'], protocols: ['internal'], permissionBoundary: '限定授权', status: 'experimental', codeEntries: ['src/test.ts'], tests: ['tests/test.ts'], docs: ['docs/test.md'], lastVerifiedCommit: 'a'.repeat(40) };
function validate(overrides = {}, options = {}) {
  return validateEntry(`---\n${JSON.stringify({ ...base, ...overrides })}\n---\n`, { ids: new Set(), exists: () => true, commitExists: () => true, committedPathExists: () => true, ...options });
}
describe('static capability dictionary', () => {
  it('validates structure and reports every explicitly unbound commit reference', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const directory = path.join(root, 'docs/capabilities/entries');
    const pending = readdirSync(directory).filter(file => file.endsWith('.md')).filter(file => {
      const source = readFileSync(path.join(directory, file), 'utf8');
      return parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(source)[1]).lastVerifiedCommit === null;
    });
    const result = checkCapabilities(root);
    expect(result.errors).toEqual(pending.sort().map(file => file + ': Invalid lastVerifiedCommit'));
  });
  it('rejects duplicate IDs, missing fields and future commit references', () => {
    expect(validate({}, { ids: new Set(['asterium.test']) })).toContain('Duplicate id asterium.test');
    expect(validate({ name: '' })).toContain('Invalid name');
    expect(validate({}, { commitExists: () => false })).toContain('Invalid lastVerifiedCommit');
    expect(validate({}, { committedPathExists: () => false })).toContain('Code absent at commit: src/test.ts');
  });
  it('rejects traversal, absolute paths, missing evidence and unknown fields', () => {
    for (const bad of ['../secret', '/etc/passwd', 'C:/secret', 'src\\file']) expect(validate({ tests: [bad] }).some(e => e.startsWith('Invalid path'))).toBe(true);
    expect(validate({}, { exists: () => false }).some(e => e.startsWith('Invalid path'))).toBe(true);
    expect(validate({ injected: true })).toContain('Unknown injected');
  });
});
