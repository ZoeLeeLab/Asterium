// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanupAutoTestRun } from '../helpers/autoTest.mjs';

const probe = path.resolve('tests/fixtures/auto-test-probe.mjs');
function settings(mode) {
  const env = { ...process.env }; delete env.ASTERIUM_AUTOTEST_RUN_ROOT; delete env.ASTERIUM_AUTOTEST_RUN_TOKEN; delete env.ASTERIUM_AUTOTEST_KEEP;
  return { command: process.execPath, args: [probe, mode], options: { env, windowsHide: true, encoding: 'utf8', timeout: 15000 } };
}
function run(mode) {
  const s = settings(mode), result = spawnSync(s.command, s.args, s.options);
  return { result, report: JSON.parse(result.stdout.trim().split('\n')[0]) };
}
function owner(report) { return JSON.parse(readFileSync(path.join(report.root, '.asterium-autotest-run.v1.json'), 'utf8')); }
describe('automatic test lifecycle', () => {
  it('preserves both execution and cleanup errors without removing failed evidence', () => {
    const value = run('both');
    expect(value.result.status).toBe(1);
    expect(value.result.stderr).toContain('EXPECTED_PROBE_FAILURE');
    expect(value.result.stderr).toContain('EXPECTED_CLEANUP_FAILURE');
    expect(existsSync(path.join(value.report.evidence, 'synthetic.txt'))).toBe(true);
    expect(cleanupAutoTestRun(owner(value.report), { allowFailed: true })).toBe(true);
  });
  it('makes direct runs fresh and cleans successful runs', () => {
    const a = run('pass'), b = run('pass');
    expect(a.result.status, a.result.stderr).toBe(0); expect(b.result.status, b.result.stderr).toBe(0);
    expect(a.report.root).not.toBe(b.report.root); expect(a.report.worker).not.toBe(b.report.worker);
    expect(existsSync(a.report.root)).toBe(false); expect(existsSync(b.report.root)).toBe(false);
  });
  it('keeps failed data and rejects wrong ownership and outbound junction cleanup', () => {
    const failed = run('fail'); expect(failed.result.status).toBe(1);
    const record = owner(failed.report), alias = path.join(failed.report.worker, 'outbound');
    const sentinel = path.join(os.tmpdir(), 'sentinel.txt'); writeFileSync(sentinel, 'unchanged');
    expect(existsSync(path.join(failed.report.evidence, 'synthetic.txt'))).toBe(true);
    expect(() => cleanupAutoTestRun({ ...record, token: 'incorrect' }, { allowFailed: true })).toThrow('OWNER_MISMATCH');
    symlinkSync(os.tmpdir(), alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => cleanupAutoTestRun(record, { allowFailed: true })).toThrow('LINK_REJECTED');
    unlinkSync(alias);
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
    expect(cleanupAutoTestRun(record)).toBe(false);
    expect(cleanupAutoTestRun(record, { allowFailed: true })).toBe(true);
  });
  it('stops its own child before cleaning a successful run', () => {
    const value = run('child'); expect(value.result.status, value.result.stderr).toBe(0);
    expect(existsSync(value.report.root)).toBe(false);
    let alive = false; try { process.kill(value.report.childPid, 0); alive = true; } catch { /* Child exited. */ }
    expect(alive).toBe(false);
  }, 15000);
  it('isolates two concurrent direct runs', async () => {
    async function start() {
      const s = settings('pass');
      return new Promise((resolve, reject) => {
        const child = spawn(s.command, s.args, s.options); let stdout = '', stderr = '';
        child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
        child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(stdout.trim().split('\n')[0])) : reject(Error(stderr)));
      });
    }
    const [a, b] = await Promise.all([start(), start()]);
    expect(a.root).not.toBe(b.root); expect(a.worker).not.toBe(b.worker);
    expect(existsSync(a.root)).toBe(false); expect(existsSync(b.root)).toBe(false);
  });
});
