// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, access, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { SandboxExtensionLaunchBackend } from '../../src/main/execution/SandboxExtensionLaunchBackend';
import type { SandboxProcessRequest, WindowsSandboxProcess } from '../../src/main/execution/WindowsSandboxProcess';
import { SkillScriptRunner } from '../../src/main/api/extensions/SkillScriptRunner';
import type { SkillPackage } from '../../src/main/api/extensions/SkillPackageLoader';
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function setup(launch: (request: SandboxProcessRequest) => Promise<unknown>) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'asterium-sandbox-skill-')); folders.push(cwd); await mkdir(path.join(cwd, 'workspace'));
  const loaded = { files: new Map([['scripts/main.mjs', Buffer.from('console.log("fixture")')]]), digest: 'approved' } as SkillPackage;
  const runner = new SkillScriptRunner(new SandboxExtensionLaunchBackend({ launch } as unknown as WindowsSandboxProcess));
  const context = { kind: 'partner_runtime' as const, partnerId: 'p', conversationId: 'c', policy: { permissionMode: 'manual' as const, planMode: 'default' as const }, workspace: { workspaceFolders: [cwd] } };
  return { cwd, loaded, runner, context };
}
it('uses a read-only immutable skill snapshot, literal argv and actual sandbox result metadata', async () => {
  let snapshot = '';
  const launch = vi.fn(async (request: SandboxProcessRequest) => {
    snapshot = request.environment.ASTERIUM_SKILL_DIRECTORY;
    expect(request.readOnlyRoots).toContain(snapshot);
    expect(await readFile(path.join(snapshot, 'scripts/main.mjs'), 'utf8')).toBe('console.log("fixture")');
    expect(request.args.slice(-2)).toEqual(['a b', '$(literal)']);
    expect(request.args[0]).toBe('--preserve-symlinks-main');
    await request.beforeStart!();
    const stdout = new PassThrough(), stderr = new PassThrough();
    const completed = new Promise(resolve => setTimeout(() => { stdout.write('S2_SKILL_OK'); resolve({ reason: 'exited', exitCode: 0 }); }, 1));
    return { pid: 123, stdout, stderr, completed, close: async () => { await completed; } };
  });
  const s = await setup(launch); const beforeStart = vi.fn(async () => undefined);
  // Policy is stamped by Main routing in production. This test uses a selected backend directly.
  const backend = new SandboxExtensionLaunchBackend({ launch } as unknown as WindowsSandboxProcess);
  const selected = { ...backend, id: 'sandbox' as const, sandboxed: true, createMcpTransport: (request: Parameters<typeof backend.createMcpTransport>[0]) => backend.createMcpTransport(request), launchSkillScript: (request: Parameters<typeof backend.launchSkillScript>[0]) => backend.launchSkillScript({ ...request, sandboxPolicy: { allowNetwork: false, policyKey: 'test' } }) };
  const runner = new SkillScriptRunner(selected);
  const result = await runner.run(s.loaded, 'scripts/main.mjs', ['a b', '$(literal)'], s.cwd, new AbortController().signal, start => start(), s.context, beforeStart);
  expect(JSON.parse(result.content)).toMatchObject({ backend: 'sandbox', sandboxed: true, output: 'S2_SKILL_OK', exitCode: 0 });
  expect(beforeStart).toHaveBeenCalledOnce(); await expect(access(snapshot)).rejects.toHaveProperty('code', 'ENOENT');
});
it('does not launch or leave an input snapshot when the selected sandbox is unavailable', async () => {
  const launch = vi.fn(async () => { throw new Error('must not reach without a stamped policy'); });
  const s = await setup(launch);
  await expect(s.runner.run(s.loaded, 'scripts/main.mjs', [], s.cwd, new AbortController().signal, start => start(), s.context)).rejects.toThrow('SANDBOX_CONTEXT_REQUIRED');
  expect(launch).not.toHaveBeenCalled();
});
async function inspectRuntime(command: string) {
  const snapshot = await mkdtemp(path.join(os.tmpdir(), 'asterium-skill-run-')); folders.push(snapshot);
  let captured!: SandboxProcessRequest;
  const launch = vi.fn(async (request: SandboxProcessRequest) => {
    captured = request;
    return { pid: 456, stdout: new PassThrough(), stderr: new PassThrough(), completed: Promise.resolve({ reason: 'exited', exitCode: 0 }), close: async () => undefined };
  });
  const s = await setup(launch), backend = new SandboxExtensionLaunchBackend({ launch } as unknown as WindowsSandboxProcess);
  const args = ['-NoProfile', '-NonInteractive', '-File', path.join(snapshot, 'probe.ps1')];
  const running = await backend.launchSkillScript({ command, args, cwd: s.cwd, env: { ASTERIUM_SKILL_DIRECTORY: snapshot }, context: s.context,
    signal: new AbortController().signal, sandboxPolicy: { allowNetwork: false, policyKey: 'test' } });
  await running.close(); return { captured, snapshot: await realpath(snapshot), args, cwd: s.cwd };
}
it.skipIf(process.platform !== 'win32')('omits only the fixed system PowerShell runtime directory while preserving snapshot and process limits', async () => {
  const command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const s = await inspectRuntime(command);
  expect(s.captured.readOnlyRoots).toEqual([s.snapshot]);
  expect(s.captured).toMatchObject({ executable: await realpath(command), cwd: s.cwd, allowNetwork: false, timeoutMs: 30_000, outputLimitBytes: 65536 });
  expect(s.captured.args.slice(0, 6)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  expect(s.captured.args[6]).toContain(Buffer.from(s.args[3], 'utf16le').toString('base64'));
});
it.each(['powershell.exe', 'python.exe', 'pwsh.exe'])('retains runtime directory checks for a non-system %s', async name => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'asterium-skill-runtime-')); folders.push(runtime);
  const command = path.join(runtime, name); await writeFile(command, 'synthetic, never executed');
  const s = await inspectRuntime(command);
  expect(s.captured.readOnlyRoots).toEqual([await realpath(runtime), s.snapshot]);
});
it.skipIf(process.platform !== 'win32')('runs real PowerShell startup through the Skill snapshot/UTF-8 result contract (local process stand-in, not AppContainer)', async () => {
  const source = Buffer.from('\uFEFFWrite-Output "技能实际运行"; [Console]::Error.WriteLine("技能中文错误"); Write-Output ("FILE="+$PSCommandPath); exit 7');
  let snapshot = '';
  const launch = async (request: SandboxProcessRequest) => {
    snapshot = request.environment.ASTERIUM_SKILL_DIRECTORY;
    expect(await readFile(path.join(snapshot, 'scripts/probe.ps1'))).toEqual(source);
    await request.beforeStart?.();
    // Deliberate local process stand-in to test the real startup/decoder. The
    // production WindowsSandboxProcess/helper are not bypassed in the app.
    const child = spawn(request.executable, request.args, { cwd: request.cwd, windowsHide: true, signal: request.signal, stdio: ['ignore', 'pipe', 'pipe'] });
    const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', exitCode => resolve({ reason: 'exited', exitCode })); });
    return { pid: child.pid!, stdout: child.stdout, stderr: child.stderr, completed, close: async () => { if (child.exitCode === null) child.kill(); await completed; } };
  };
  const s = await setup(launch), backend = new SandboxExtensionLaunchBackend({ launch } as unknown as WindowsSandboxProcess);
  const selected = { id: backend.id, sandboxed: backend.sandboxed, createMcpTransport: backend.createMcpTransport.bind(backend), launchSkillScript: (request: Parameters<typeof backend.launchSkillScript>[0]) => backend.launchSkillScript({ ...request, sandboxPolicy: { allowNetwork: false, policyKey: 'test' } }) };
  const runner = new SkillScriptRunner(selected), beforeStart = vi.fn(async () => undefined);
  const result = await runner.run({ files: new Map([['scripts/probe.ps1', source]]) } as SkillPackage, 'scripts/probe.ps1', [], s.cwd, new AbortController().signal, start => start(), s.context, beforeStart);
  const content = JSON.parse(result.content);
  expect(content).toMatchObject({ backend: 'sandbox', sandboxed: true, exitCode: 7 });
  expect(content.output).toContain('技能实际运行'); expect(content.output).toContain('技能中文错误'); expect(content.output).not.toContain('\uFFFD');
  expect(content.output).toContain('FILE=' + path.join(snapshot, 'scripts/probe.ps1'));
  expect(beforeStart).toHaveBeenCalledOnce(); await expect(access(snapshot)).rejects.toHaveProperty('code', 'ENOENT');
});
