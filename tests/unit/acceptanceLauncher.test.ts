// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const base = path.join(os.tmpdir(), 'Asterium-AutoTest'); mkdirSync(base, { recursive: true });
const run = realpathSync.native(mkdtempSync(path.join(base, 'acceptance-launcher-')));
const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = path.resolve('tools/acceptance/Start-AsteriumAcceptance.ps1');
afterAll(() => { expect(path.dirname(realpathSync.native(run))).toBe(realpathSync.native(base)); rmSync(run, { recursive: true }); });
function fixture() {
  const root = realpathSync.native(mkdtempSync(path.join(run, 'worker-'))), app = path.join(root, '测试候选 with spaces'); mkdirSync(app);
  const exe = path.join(app, 'Asterium.exe'); writeFileSync(exe, 'synthetic-not-executable');
  const local = path.join(root, 'local');
  return { root, exe, local, run: (...args: string[]) => spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', script, '-ExecutablePath', exe, '-Batch', 'round-1', '-Port', '17363', '-DryRun', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, LOCALAPPDATA: local } }) };
}
describe('acceptance launcher dry run', () => {
  it('binds exact candidate, batch, port and independent data without launching or writing data', () => {
    const f = fixture(), result = f.run(); expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.executable).toBe(f.exe);
    expect(receipt.executableSha256).toBe(createHash('sha256').update('synthetic-not-executable').digest('hex'));
    expect(receipt.arguments).toEqual(['--asterium-profile=acceptance', '--asterium-acceptance-batch=round-1', '--asterium-mcp-port=17363', `--user-data-dir=${path.join(f.local, 'Asterium-Test', 'round-1')}`]);
    expect(receipt.dryRun).toBe(true); expect(receipt.processId).toBeUndefined(); expect(existsSync(f.local)).toBe(false);
  });
  it('rejects unmarked nonempty data and reuses explicitly marked acceptance data', () => {
    const f = fixture(), data = path.join(f.root, '验收资料'); mkdirSync(data); writeFileSync(path.join(data, 'keep'), 'fixture');
    const failed = f.run('-DataDirectory', data); expect(failed.status).not.toBe(0); expect(failed.stderr).toContain('ASTERIUM_ACCEPTANCE_UNCLAIMED_DIRECTORY');
    writeFileSync(path.join(data, '.asterium-profile.v1.json'), JSON.stringify({ version: 1, profile: 'acceptance' }));
    const result = f.run('-DataDirectory', data, '-BackgroundServices'); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).arguments).toContain('--asterium-background-services');
  });
  it('rejects daily-owned data and Windows junction aliases', () => {
    const f = fixture(), daily = path.join(f.root, 'daily'); mkdirSync(daily);
    writeFileSync(path.join(daily, '.asterium-profile.v1.json'), JSON.stringify({ version: 1, profile: 'daily' }));
    const owned = f.run('-DataDirectory', daily); expect(owned.status).not.toBe(0); expect(owned.stderr).toContain('ASTERIUM_ACCEPTANCE_OWNER_MISMATCH');
    const alias = path.join(f.root, 'alias'); symlinkSync(daily, alias, 'junction');
    try { const linked = f.run('-DataDirectory', alias); expect(linked.status).not.toBe(0); expect(linked.stderr).toContain('ASTERIUM_ACCEPTANCE_LINKED_DIRECTORY'); }
    finally { rmSync(alias, { recursive: true }); }
  });
});
