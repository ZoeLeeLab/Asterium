// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { autoTestOutput } from '../helpers/autoTest.mjs';
import { createLocalRuntimeResolver, resolveProjectRuntimeRoot } from '../../src/main/runtime/LocalRuntimeResolver';
import type { CodexInstallation } from '../../src/main/adapters/CodexCliAdapter';
import type { NativeThreadBinding } from '../../src/shared/studioRuntime';

async function fixture() {
  const root = autoTestOutput(), workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile');
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(profile, { recursive: true })]);
  const executablePath = path.join(root, 'fixture-cli.exe'); await writeFile(executablePath, 'synthetic executable identity only');
  const runtime: CodexInstallation['runtimes'][number] = { installed: true, loggedIn: true, runtimeId: 'fixture-runtime', environment: 'global_cli',
    environmentLabel: 'Fixture', executablePath, executableLabel: 'fixture-cli.exe', codexHome: path.join(root, 'codex-home') };
  const dependencies = {
    nativeBindings: { getForScope: vi.fn<() => Promise<NativeThreadBinding | undefined>>(async () => undefined) },
    singleChatHistory: { readMetadata: vi.fn(async () => undefined) }, conversationDeletions: { isDeleted: vi.fn(async () => false) },
    workspaceGrants: { get: vi.fn(async () => workspace) }, grants: new Map<string, string>(), protectedRoots: [profile], userDataDirectory: () => profile,
    detectCodex: vi.fn(async () => ({ installed: true, loggedIn: true, runtimes: [runtime], recommendedRuntimeId: runtime.runtimeId })),
    detectClaude: vi.fn(async () => ({ installed: true, loggedIn: true, executablePath })),
  };
  return { root, workspace, profile, runtime, dependencies, resolver: createLocalRuntimeResolver(dependencies) };
}

it('shares detection caches with explicit IPC refresh and refreshes a missing Codex selection only once', async () => {
  const f = await fixture();
  await f.resolver.ensureCodexInstallation(); await f.resolver.ensureCodexInstallation();
  expect(f.dependencies.detectCodex).toHaveBeenCalledTimes(1);
  expect(f.resolver.currentCodexInstallation()?.runtimes[0]).toBe(f.runtime);
  await f.resolver.refreshCodexInstallation();
  expect(await f.resolver.resolveSelectedCodexRuntime('fixture-removed', 'global_cli')).toBe(f.runtime);
  await expect(f.resolver.resolveSelectedCodexRuntime('fixture-removed')).rejects.toThrow('CODEX_RUNTIME_SELECTION_REQUIRED');
  expect(f.dependencies.detectCodex).toHaveBeenCalledTimes(3);
  await f.resolver.ensureClaudeInstallation(); await f.resolver.ensureClaudeInstallation();
  expect(f.dependencies.detectClaude).toHaveBeenCalledTimes(1);
  await f.resolver.refreshClaudeInstallation(); expect(f.dependencies.detectClaude).toHaveBeenCalledTimes(2);
});

it('keeps directory, protected-root and cached grant validation on the authoritative paths', async () => {
  const f = await fixture();
  expect(await f.resolver.availableImportedDirectory(f.workspace)).toBeTruthy();
  expect(await f.resolver.availableImportedDirectory(f.workspace, f.profile)).toBeUndefined();
  expect(await f.resolver.availableImportedDirectory(f.profile)).toBeUndefined();
  expect(await f.resolver.resolveWorkspaceGrant('fixture-grant')).toBe(f.workspace);
  await f.resolver.resolveWorkspaceGrant('fixture-grant'); expect(f.dependencies.workspaceGrants.get).toHaveBeenCalledTimes(1);
  f.dependencies.grants.set('fixture-protected', f.profile);
  await expect(f.resolver.resolveWorkspaceGrant('fixture-protected')).rejects.toThrow();
  await expect(resolveProjectRuntimeRoot(path.join(f.root, 'missing'), [f.profile])).rejects.toThrow('PROJECT_WORKSPACE_NOT_READY');
  await expect(resolveProjectRuntimeRoot(f.profile, [f.profile])).rejects.toThrow();
});

it('retains imported thread identity, deletion and Codex-home checks', async () => {
  const f = await fixture();
  const workspace = { originalCwd: f.workspace, directory: f.workspace, canonicalDirectory: f.workspace, runtimeId: f.runtime.runtimeId,
    runtimeEnvironment: f.runtime.environment, codexHome: f.runtime.codexHome };
  const binding: NativeThreadBinding = { bindingId: 'fixture-binding', generation: 1, state: 'active', source: 'local_cli', scope: 'single',
    partnerId: 'fixture-partner', conversationId: 'fixture-chat', nativeThreadId: 'fixture-thread', importedCodexWorkspace: workspace, createdAt: '', updatedAt: '' };
  f.dependencies.nativeBindings.getForScope.mockResolvedValue(binding);
  expect(await f.resolver.importedCodexBinding('fixture-partner', 'fixture-chat', 'fixture-thread')).toEqual({ binding, workspace });
  await expect(f.resolver.importedCodexBinding('fixture-partner', 'fixture-chat', 'fixture-other-thread')).rejects.toThrow('CODEX_IMPORTED_THREAD_MISMATCH');
  f.dependencies.conversationDeletions.isDeleted.mockResolvedValue(true);
  await expect(f.resolver.importedCodexBinding('fixture-partner', 'fixture-chat', 'fixture-thread')).rejects.toThrow('CODEX_IMPORTED_THREAD_MISMATCH');
  await expect(f.resolver.resolveImportedCodexRuntime({ ...workspace, codexHome: path.join(f.root, 'another-home') })).rejects.toThrow('CODEX_IMPORTED_HOME_CHANGED');
});
