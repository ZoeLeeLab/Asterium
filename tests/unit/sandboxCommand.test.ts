// @vitest-environment node
import { testRm as rm } from '../helpers/autoTest.mjs';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { SandboxExtensionLaunchBackend } from '../../src/main/execution/SandboxExtensionLaunchBackend';
import { WindowsSandboxProcess, type SandboxProcessRequest } from '../../src/main/execution/WindowsSandboxProcess';
const context = { kind: 'partner_runtime' as const, partnerId: 'p', conversationId: 'c', policy: { permissionMode: 'manual' as const, planMode: 'default' as const }, workspace: { workspaceFolders: ['K:\\workspace'] } };
it('launches the fixed PowerShell through the sandbox service with only explicit resources', async () => {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const launch = vi.fn(async (request: SandboxProcessRequest) => {
    expect(request.executable).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    const completed = new Promise(resolve => setTimeout(() => { stdout.write('OK'); resolve({ reason: 'exited', exitCode: 0 }); }, 0));
    return { stdout, stderr, completed };
  });
  const backend = new SandboxExtensionLaunchBackend({ launch } as unknown as WindowsSandboxProcess);
  const started = vi.fn();
  expect(await backend.runCommand({ command: 'echo OK', cwd: 'K:\\workspace', context, signal: new AbortController().signal, sandboxPolicy: { allowNetwork: false, policyKey: 'one' }, onStarted: started })).toBe('OK');
  expect(started).toHaveBeenCalledExactlyOnceWith({ backend: 'sandbox', sandboxed: true });
  expect(launch.mock.calls[0][0]).toMatchObject({ args: ['-NoProfile', '-NonInteractive', '-Command', expect.stringContaining("New-PSDrive -Name AsteriumWorkspace -PSProvider FileSystem -Root 'K:\\workspace' -Scope Local")], cwd: 'K:\\workspace', readOnlyRoots: [], environment: {}, allowNetwork: false, timeoutMs: 120000 });
  expect(launch.mock.calls[0][0].args.at(-1)).toContain("Set-Location -LiteralPath 'AsteriumWorkspace:\\' -ErrorAction Stop");
  expect(launch.mock.calls[0][0].args.at(-1)).not.toContain('-Persist');
});
it('does not retry a helper failure as another operation', async () => {
  const launch = vi.fn(async () => { throw new Error('SANDBOX_HELPER_INTEGRITY_FAILED'); });
  const backend = new SandboxExtensionLaunchBackend({ launch } as unknown as WindowsSandboxProcess);
  await expect(backend.runCommand({ command: 'echo x', cwd: 'K:\\workspace', context, signal: new AbortController().signal, sandboxPolicy: { allowNetwork: true, policyKey: 'one' } })).rejects.toThrow('SANDBOX_HELPER_INTEGRITY_FAILED');
  expect(launch).toHaveBeenCalledOnce();
});
it('does not create a process when no authorized root contains cwd, including sibling-prefix paths', async () => {
  const launch = vi.fn();
  const backend = new SandboxExtensionLaunchBackend({ launch } as unknown as WindowsSandboxProcess);
  const request = { command: 'echo x', cwd: 'K:\\workspace-other', context, signal: new AbortController().signal, sandboxPolicy: { allowNetwork: false, policyKey: 'one' } };
  await expect(backend.runCommand(request)).rejects.toThrow('SANDBOX_CWD_OUTSIDE_WORKSPACE');
  await expect(backend.runCommand({ ...request, cwd: 'K:\\workspace', context: { ...context, workspace: { workspaceFolders: [] } } })).rejects.toThrow('SANDBOX_AUTHORIZED_WORKSPACE_REQUIRED');
  expect(launch).not.toHaveBeenCalled();
});
it.runIf(process.platform === 'win32' && existsSync('.sandbox-build/sandbox/AsteriumSandboxHelper.exe'))('real production helper reports/rejects the current elevated host before state is created', async () => {
  const root = path.resolve('.qa', 'sandbox-s2', `elevated-refusal-${randomUUID()}`);
  const service = new WindowsSandboxProcess(path.resolve('.sandbox-build/sandbox'), root, []);
  const host = await service.inspectHost();
  if (!host.elevated) return; // The separate ordinary-account acceptance covers this case.
  expect(host.hostAllowed).toBe(false);
  await expect(service.launch({ context, executable: process.execPath, args: [], cwd: 'K:\\workspace', readOnlyRoots: [], environment: {}, allowNetwork: false, timeoutMs: 1000, outputLimitBytes: 65536, signal: new AbortController().signal })).rejects.toThrow('SANDBOX_ELEVATED_HOST_REFUSED');
  await expect(lstat(root)).rejects.toHaveProperty('code', 'ENOENT');
});

// Actual PowerShell syntax/location tests through a captured backend request.
// These deliberately run Native fixtures, not the OS sandbox or an elevation bypass.
async function commandFixture(command: string, cwd: string, roots = [cwd]) {
  let captured!: SandboxProcessRequest;
  const backend = new SandboxExtensionLaunchBackend({ launch: async (request: SandboxProcessRequest) => {
    captured = request;
    return { pid: 1, stdout: new PassThrough(), stderr: new PassThrough(), completed: Promise.resolve({ reason: 'exited', exitCode: 0 }), send: async () => undefined, close: async () => undefined };
  } } as unknown as WindowsSandboxProcess);
  await backend.runCommand({ command, cwd, context: { ...context, workspace: { workspaceFolders: roots } }, signal: new AbortController().signal, sandboxPolicy: { allowNetwork: false, policyKey: 'cwd' } });
  return captured;
}
const runPowerShell = promisify(execFile);
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
it.runIf(process.platform === 'win32')('sets the literal provider cwd before relative IO even when PowerShell starts in another location', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-sandbox-cwd-'));
  try {
    const workspace = path.join(root, "space ' $(throw 'injected') 中文"), stale = path.join(root, 'stale');
    await mkdir(workspace); await mkdir(stale);
    const request = await commandFixture("Set-Content -LiteralPath '.\\result.txt' -Value 'S2_CWD_OK'; Get-Content -LiteralPath '.\\result.txt'", workspace);
    const { stdout, stderr } = await runPowerShell(request.executable, [...request.args.slice(0, -1), `Set-Location -LiteralPath ${literal(stale)}; ${request.args.at(-1)}`], { cwd: workspace, windowsHide: true, timeout: 10_000 });
    expect(stderr).toBe('');
    expect(stdout).toContain('S2_CWD_OK');
    expect(await readFile(path.join(workspace, 'result.txt'), 'utf8')).toContain('S2_CWD_OK');
    await expect(lstat(path.join(stale, 'result.txt'))).rejects.toHaveProperty('code', 'ENOENT');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.runIf(process.platform === 'win32')('fails before the user command when the provider cwd cannot be entered, even with a user trap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-sandbox-cwd-fail-'));
  try {
    const marker = path.join(root, 'must-not-run.txt');
    const request = await commandFixture(`trap { continue }; Set-Content -LiteralPath ${literal(marker)} -Value 'BAD'`, path.join(root, 'missing'));
    await expect(runPowerShell(request.executable, request.args, { cwd: root, windowsHide: true, timeout: 10_000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('SANDBOX_COMMAND_CWD_UNAVAILABLE') });
    await expect(lstat(marker)).rejects.toHaveProperty('code', 'ENOENT');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.runIf(process.platform === 'win32')('preserves param/using script syntax, literal command strings and explicit exit codes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-sandbox-cwd-script-'));
  try {
    const request = await commandFixture("using namespace System.Text\nparam()\nWrite-Output 'literal ''quote'' $(not-code)'; exit 7", root);
    await expect(runPowerShell(request.executable, request.args, { cwd: root, windowsHide: true, timeout: 10_000 })).rejects.toMatchObject({ code: 7, stdout: expect.stringContaining("literal 'quote' $(not-code)") });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.runIf(process.platform === 'win32')('maps nested cwd under the authorized root, keeps parent navigation within that root and gives native children the real cwd', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-sandbox-drive-'));
  try {
    const nested = path.join(root, 'src'); await mkdir(nested);
    const cmd = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const request = await commandFixture(`Set-Content -LiteralPath '.\\nested.txt' -Value 'S2_NESTED_OK' -ErrorAction Stop; $childCwd = & ${literal(cmd)} /d /c cd; if ($LASTEXITCODE -ne 0) { throw 'CHILD_FAILED' }; Write-Output ('CHILD_CWD=' + $childCwd); Write-Output ('ALIAS=' + $PWD.Path); Set-Location -LiteralPath '..' -ErrorAction Stop; Write-Output ('PARENT=' + (Get-Location).ProviderPath)`, nested, [nested, root]);
    expect(request.cwd).toBe(nested);
    expect(request.args.at(-1)).toContain(`-Root ${literal(root)} -Scope Local`);
    const { stdout, stderr } = await runPowerShell(request.executable, request.args, { cwd: nested, windowsHide: true, timeout: 10_000 });
    expect(stderr).toBe('');
    expect(stdout).toContain('CHILD_CWD=' + nested);
    expect(stdout).toContain('ALIAS=AsteriumWorkspace:\\src');
    expect(stdout).toContain('PARENT=' + root);
    expect(await readFile(path.join(nested, 'nested.txt'), 'utf8')).toContain('S2_NESTED_OK');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.runIf(process.platform === 'win32').each([
  ["Get-Content -LiteralPath '.\\missing-fixture.txt'", 1],
  ["Write-Error 'EXPECTED_ERROR'; Write-Output 'RECOVERED'", 0],
  ["Write-Error 'FINAL_ERROR'", 1],
] as const)('retains the original PowerShell final-status behavior for %s', async (command, expectedCode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-sandbox-cwd-status-'));
  try {
    const request = await commandFixture(command, root);
    const observe = async (script: string) => {
      try { const result = await runPowerShell(request.executable, ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: root, windowsHide: true, timeout: 10_000 }); return { code: 0, stdout: result.stdout }; }
      catch (error) { const result = error as { code: number; stdout: string }; return { code: result.code, stdout: result.stdout }; }
    };
    const original = await observe(command), wrapped = await observe(request.args.at(-1)!);
    expect(original.code).toBe(expectedCode); expect(wrapped).toEqual(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
