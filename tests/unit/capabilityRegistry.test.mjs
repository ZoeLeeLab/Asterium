// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validateEntry, checkCapabilities } from '../../scripts/check-capabilities.mjs';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { testRm } from '../helpers/autoTest.mjs';

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

  it('distinguishes referenced commits, non-commits and working files missing at the referenced commit', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'asterium-capabilities-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git('init', '--quiet', '--object-format=sha1');
      const directory = path.join(root, 'docs/capabilities/entries');
      mkdirSync(directory, { recursive: true });
      mkdirSync(path.join(root, 'src'));
      mkdirSync(path.join(root, 'tests'));
      const committedFile = 'src/fixture with spaces.ts';
      writeFileSync(path.join(root, committedFile), '// fixture\n');
      git('add', '--', committedFile);
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=.git/no-fixture-hooks', 'commit', '--quiet', '-m', 'Fixture baseline');

      const sha = git('rev-parse', 'HEAD');
      const blob = git('rev-parse', `HEAD:${committedFile}`);
      const workingFile = 'src/working.ts';
      for (const file of [workingFile, ...base.tests, ...base.docs]) writeFileSync(path.join(root, file), 'fixture\n');
      const entries = [
        ['committed', sha, [committedFile]],
        ['missing-path', sha, [workingFile]],
        ['non-commit', blob, [committedFile]],
        ['unknown', '0'.repeat(40), [committedFile]],
        ['unbound', null, [committedFile]],
      ];
      writeFileSync(path.join(root, 'docs/capabilities/index.md'), entries.map(([name]) => `[${name}](entries/${name}.md)`).join('\n'));
      for (const [name, lastVerifiedCommit, codeEntries] of entries) {
        const entry = { ...base, id: `asterium.${name}`, lastVerifiedCommit, codeEntries };
        writeFileSync(path.join(directory, `${name}.md`), `---\n${JSON.stringify(entry)}\n---\n`);
      }
      expect(checkCapabilities(root)).toEqual({ count: 5, errors: [
        `missing-path.md: Code absent at commit: ${workingFile}`,
        'non-commit.md: Invalid lastVerifiedCommit',
        'unbound.md: Invalid lastVerifiedCommit',
        'unknown.md: Invalid lastVerifiedCommit',
      ] });
    } finally {
      await testRm(root, { recursive: true, force: true });
    }
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
