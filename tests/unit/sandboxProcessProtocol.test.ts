// @vitest-environment node
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
const controls = vi.hoisted(() => ({ values: [] as Array<{ type?: string; id?: string }>, resumed: false }));
vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: null, value: string) => void) => callback(null, JSON.stringify({ version: 2, elevated: false, appContainer: false, adminGroupsEnabled: false, integrityRid: 8192, hostAllowed: true })),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: 999999, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null });
    let id = '';
    const event = (type: string) => child.stdout.write(JSON.stringify({ type, pid: 999998, helperPid: child.pid, profile: 'appcontainer', profileName: `Asterium.Sandbox.${id}`, appContainer: true, elevated: false, inJob: true, network: 'blocked', identity: { method: 'access_check_controls', verified: true, observedProfile: 'appcontainer', packageMatches: true, userMatches: true, userOnlyDenied: true, packageAllowed: true, allApplicationPackagesAllowed: true } }) + '\n');
    const end = (code: number) => { child.exitCode = code; child.emit('close', code); };
    child.stdin.on('data', data => {
      const value = JSON.parse(data.toString()); controls.values.push(value);
      if (value.id) { id = value.id; queueMicrotask(() => event('prepared')); }
      else if (value.type === 'start') {
        controls.resumed = true;
        queueMicrotask(() => {
          event('ready');
          child.stdout.write(JSON.stringify({ type: 'result', reason: 'exited', exitCode: 0, cleanup: 'confirmed', started: true, profile: 'appcontainer', network: 'blocked' }) + '\n');
          end(0);
        });
      } else if (value.type === 'cancel') queueMicrotask(() => end(1));
    });
    return Object.assign(child, { kill: () => { end(1); return true; } });
  },
}));
import { WindowsSandboxProcess, type SandboxProcessRequest } from '../../src/main/execution/WindowsSandboxProcess';
const folders: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); controls.values = []; controls.resumed = false; });
async function fixture(beforeStart: () => Promise<void>, configure?: (paths: { root: string; helper: string; workspace: string }) => Promise<Partial<SandboxProcessRequest>>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-sandbox-protocol-')); folders.push(root);
  const helper = path.join(root, 'helper'), workspace = path.join(root, 'workspace'); await mkdir(helper); await mkdir(workspace);
  await writeFile(path.join(helper, 'AsteriumSandboxHelper.exe'), 'fake-helper');
  await writeFile(path.join(helper, 'manifest.json'), JSON.stringify({ version: 2, architecture: 'x64', executableSha256: createHash('sha256').update('fake-helper').digest('hex') }));
  const service = new WindowsSandboxProcess(helper, path.join(root, 'state'), []);
  const overrides = await configure?.({ root, helper, workspace });
  return service.launch({ context: { kind: 'partner_runtime', partnerId: 'p', conversationId: 'c', workspace: { workspaceFolders: [workspace] } }, executable: process.execPath, args: [], cwd: workspace, readOnlyRoots: [], environment: {}, allowNetwork: false, timeoutMs: 1000, outputLimitBytes: 65536, signal: new AbortController().signal, beforeStart, ...overrides });
}
it.runIf(process.platform === 'win32')('never resumes the suspended target when final authorization was revoked', async () => {
  await expect(fixture(async () => { throw new Error('revoked'); })).rejects.toThrow('SANDBOX_AUTHORITY_CHANGED');
  expect(controls.resumed).toBe(false); expect(controls.values.some(value => value.type === 'start')).toBe(false);
});
it.runIf(process.platform === 'win32')('permits one correlated start only after final Main authorization', async () => {
  const authorized = vi.fn(async () => undefined);
  const process = await fixture(authorized); await expect(process.completed).resolves.toMatchObject({ cleanup: 'confirmed', exitCode: 0 });
  expect(authorized).toHaveBeenCalledOnce(); expect(controls.values.filter(value => value.type === 'start')).toHaveLength(1);
});
it.runIf(process.platform === 'win32')('accepts the real system PowerShell hardlink only as an executable without granting it a runtime root', async () => {
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Real Windows filesystem evidence, with simulated helper IO: no OS sandbox success claim.
  expect((await lstat(executable)).isSymbolicLink()).toBe(false);
  const running = await fixture(async () => undefined, async () => ({ executable }));
  await expect(running.completed).resolves.toMatchObject({ cleanup: 'confirmed' });
  expect(controls.values[0]).toMatchObject({ executable: await realpath(executable), readOnlyRoots: [] });
  expect(controls.values.filter(value => value.type === 'start')).toHaveLength(1);
});
it.runIf(process.platform === 'win32')('still refuses a hardlinked user executable even when its filename is powershell.exe', async () => {
  await expect(fixture(async () => undefined, async ({ root }) => {
    const source = path.join(root, 'source.exe'), executable = path.join(root, 'powershell.exe');
    await writeFile(source, 'fixture'); await link(source, executable);
    return { executable };
  })).rejects.toThrow('SANDBOX_REPARSE_OR_HARDLINK_PATH');
  expect(controls.values).toEqual([]);
});
it.runIf(process.platform === 'win32')('allows only the exact system PowerShell leaf with multiple links in a deterministic filesystem fixture', async () => {
  const running = await fixture(async () => undefined, async ({ root }) => {
    const windows = path.join(root, 'windows'), directory = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0');
    await mkdir(directory, { recursive: true });
    const source = path.join(root, 'serviced.exe'), executable = path.join(directory, 'powershell.exe');
    await writeFile(source, 'fixture'); await link(source, executable);
    expect((await lstat(executable)).nlink).toBe(2);
    vi.stubEnv('SystemRoot', windows);
    return { executable };
  });
  await expect(running.completed).resolves.toMatchObject({ cleanup: 'confirmed' });
  expect(controls.values.filter(value => value.type === 'start')).toHaveLength(1);
});
it.runIf(process.platform === 'win32')('still rejects a junction ancestor even for the exact system PowerShell executable path', async () => {
  await expect(fixture(async () => undefined, async ({ root }) => {
    const windows = path.join(root, 'windows'), runtime = path.join(root, 'runtime');
    await mkdir(windows); await mkdir(path.join(runtime, 'WindowsPowerShell', 'v1.0'), { recursive: true });
    await writeFile(path.join(runtime, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'fixture');
    await symlink(runtime, path.join(windows, 'System32'), 'junction');
    vi.stubEnv('SystemRoot', windows);
    return { executable: path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') };
  })).rejects.toThrow('SANDBOX_REPARSE_OR_HARDLINK_PATH');
  expect(controls.values).toEqual([]);
});
it.runIf(process.platform === 'win32').each(['AsteriumSandboxHelper.exe', 'manifest.json'])('still refuses a hardlinked helper resource: %s', async name => {
  await expect(fixture(async () => undefined, async ({ root, helper }) => {
    await link(path.join(helper, name), path.join(root, 'linked-resource'));
    return {};
  })).rejects.toThrow('SANDBOX_REPARSE_OR_HARDLINK_PATH');
  expect(controls.values).toEqual([]);
});
it.runIf(process.platform === 'win32')('does not apply the system-executable exception to a readonly grant path', async () => {
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // A hardlink presented as a grant is rejected, even at the exact exception path.
  if ((await lstat(executable)).nlink === 1) return;
  await expect(fixture(async () => undefined, async () => ({ executable, readOnlyRoots: [executable] }))).rejects.toThrow('SANDBOX_REPARSE_OR_HARDLINK_PATH');
  expect(controls.values).toEqual([]);
});
it.runIf(process.platform === 'win32').each(['cwd', 'readOnlyRoots', 'workspace'])('still refuses a junction in %s before any operation', async field => {
  await expect(fixture(async () => undefined, async ({ root, workspace }) => {
    const junction = path.join(root, 'junction'); await symlink(workspace, junction, 'junction');
    if (field === 'workspace') return { context: { kind: 'partner_runtime', partnerId: 'p', conversationId: 'c', workspace: { workspaceFolders: [junction] } } };
    return field === 'cwd' ? { cwd: junction } : { readOnlyRoots: [junction] };
  })).rejects.toThrow('SANDBOX_REPARSE_OR_HARDLINK_PATH');
  expect(controls.values).toEqual([]);
});
