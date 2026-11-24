import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CodexRuntimeInfo, LocalThreadLifecycleRequest } from '../../shared/agentProtocol';
import { resolveCodexRuntime } from '../../shared/codexRuntimeSelection';
import type { ImportedCodexWorkspace } from '../../shared/codexThreadImport';
import { detectClaudeCode, type ClaudeInstallation } from '../adapters/ClaudeCodeAdapter';
import { detectCodexCli, type CodexInstallation } from '../adapters/CodexCliAdapter';
import { sameCodexPath } from '../adapters/codexSessionFile';
import type { ConversationDeletionService } from '../conversation/ConversationDeletionService';
import type { SingleChatHistoryStore } from '../conversation/SingleChatHistoryStore';
import { assertCanonicalPathOutsideProtectedRoots } from '../security/ProtectedPathPolicy';
import type { WorkspaceGrantStore } from '../security/WorkspaceGrantStore';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';

interface LocalRuntimeResolverDependencies {
  nativeBindings: Pick<NativeThreadBindingStore, 'getForScope'>;
  singleChatHistory: Pick<SingleChatHistoryStore, 'readMetadata'>;
  conversationDeletions: Pick<ConversationDeletionService, 'isDeleted'>;
  workspaceGrants: Pick<WorkspaceGrantStore, 'get'>;
  grants: Map<string, string>;
  protectedRoots: readonly string[];
  userDataDirectory: () => string;
  detectCodex?: typeof detectCodexCli;
  detectClaude?: typeof detectClaudeCode;
}

/** One owner for installation caches and authoritative native/workspace resolution. */
export function createLocalRuntimeResolver(dependencies: LocalRuntimeResolverDependencies) {
  const { nativeBindings, singleChatHistory, conversationDeletions, workspaceGrants, grants, protectedRoots, userDataDirectory } = dependencies;
  const detectCodex = dependencies.detectCodex ?? detectCodexCli;
  const detectClaude = dependencies.detectClaude ?? detectClaudeCode;
  let claudeInstallation: ClaudeInstallation | undefined;
  let codexInstallation: CodexInstallation | undefined;
  async function availableImportedDirectory(directory: string, canonicalDirectory?: string) {
    if (!path.isAbsolute(directory)) return undefined;
    try {
      const canonical = await realpath(directory);
      if (canonicalDirectory && !sameCodexPath(canonical, canonicalDirectory)) return undefined;
      if (!(await stat(canonical)).isDirectory()) return undefined;
      await assertCanonicalPathOutsideProtectedRoots(canonical, [...protectedRoots, userDataDirectory()]);
      return canonical;
    } catch {
      return undefined;
    }
  }

  async function resolveSelectedCodexRuntime(runtimeId?: string, environment?: CodexRuntimeInfo['environment']) {
    let installation = await ensureCodexInstallation();
    let runtime = resolveCodexRuntime(installation.runtimes, runtimeId, environment);
    if (!runtime) {
      codexInstallation = await detectCodex();
      installation = codexInstallation;
      runtime = resolveCodexRuntime(installation.runtimes, runtimeId, environment);
    }
    if (!runtime) throw new Error('CODEX_RUNTIME_SELECTION_REQUIRED');
    if (!runtime.loggedIn) throw new Error('CODEX_NOT_LOGGED_IN');
    return runtime;
  }

  async function resolveCodexDirectoryRuntime(runtimeId?: string, environment?: CodexRuntimeInfo['environment'], codexHome?: string) {
    const matches = (installation: CodexInstallation) => {
      const runtimes = installation.runtimes.filter(runtime => !codexHome || sameCodexPath(runtime.codexHome, codexHome));
      return resolveCodexRuntime(runtimes.filter(runtime => runtime.loggedIn), runtimeId, environment);
    };
    const hadCachedRuntimes = Boolean(codexInstallation?.runtimes.length);
    let runtime = matches(await ensureCodexInstallation());
    const stillInstalled = runtime && await access(runtime.executablePath).then(() => true, () => false);
    if (!stillInstalled && hadCachedRuntimes) {
      codexInstallation = await detectCodex();
      runtime = matches(codexInstallation);
    }
    if (!runtime) throw new Error('找不到与伙伴配置相符且已登录的 Codex 运行时，请重新检测并选择。');
    return runtime;
  }

  async function resolveImportedCodexRuntime(workspace: ImportedCodexWorkspace) {
    const runtime = await resolveSelectedCodexRuntime(workspace.runtimeId, workspace.runtimeEnvironment);
    if (!sameCodexPath(runtime.codexHome, workspace.codexHome)) throw new Error('CODEX_IMPORTED_HOME_CHANGED');
    return runtime;
  }

  async function importedCodexBinding(partnerId: string, conversationId: string, threadId?: string) {
    const binding = await nativeBindings.getForScope(partnerId, 'single', conversationId);
    if (!binding?.importedCodexWorkspace) {
      if ((await singleChatHistory.readMetadata(conversationId))?.importedCodexThread) {
        throw new Error('CODEX_IMPORTED_THREAD_MISMATCH');
      }
      return undefined;
    }
    if (binding.state !== 'active' || (threadId !== undefined && binding.nativeThreadId !== threadId)
      || await conversationDeletions.isDeleted(conversationId)) throw new Error('CODEX_IMPORTED_THREAD_MISMATCH');
    return { binding, workspace: binding.importedCodexWorkspace };
  }

  async function ensureCodexInstallation() {
    if (!codexInstallation?.runtimes.length) codexInstallation = await detectCodex();
    return codexInstallation;
  }

  async function resolveCodexLifecycleRuntime(value: Pick<LocalThreadLifecycleRequest, 'partnerRootGrantId' | 'codexRuntimeId' | 'codexRuntimeEnvironment'>) {
    if (!value.partnerRootGrantId) throw new Error('PARTNER_ROOT_GRANT_REQUIRED');
    const workingDirectory = await resolveWorkspaceGrant(value.partnerRootGrantId);
    if (!workingDirectory) throw new Error('PARTNER_ROOT_GRANT_REQUIRED');
    let installation = await ensureCodexInstallation();
    let runtime = resolveCodexRuntime(installation.runtimes, value.codexRuntimeId, value.codexRuntimeEnvironment);
    if (!runtime) {
      codexInstallation = await detectCodex();
      installation = codexInstallation;
      runtime = resolveCodexRuntime(installation.runtimes, value.codexRuntimeId, value.codexRuntimeEnvironment);
    }
    if (!runtime) throw new Error('CODEX_RUNTIME_SELECTION_REQUIRED');
    if (!runtime.loggedIn) throw new Error('CODEX_NOT_LOGGED_IN');
    return { runtime, workingDirectory };
  }

  async function resolveWorkspaceGrant(grantId: string) {
    const current = grants.get(grantId);
    if (current) {
      await assertCanonicalPathOutsideProtectedRoots(current, protectedRoots);
      return current;
    }
    const restored = await workspaceGrants.get(grantId);
    if (restored) {
      await assertCanonicalPathOutsideProtectedRoots(restored, protectedRoots);
      grants.set(grantId, restored);
    }
    return restored;
  }

  async function ensureClaudeInstallation() {
    if (!claudeInstallation?.executablePath || !claudeInstallation.loggedIn) claudeInstallation = await detectClaude();
    return claudeInstallation;
  }
  async function refreshCodexInstallation() { codexInstallation = await detectCodex(); return codexInstallation; }
  async function refreshClaudeInstallation() { claudeInstallation = await detectClaude(); return claudeInstallation; }
  return { availableImportedDirectory, resolveSelectedCodexRuntime, resolveCodexDirectoryRuntime, resolveImportedCodexRuntime, importedCodexBinding, ensureCodexInstallation, resolveCodexLifecycleRuntime, resolveWorkspaceGrant, ensureClaudeInstallation, refreshCodexInstallation, refreshClaudeInstallation, currentCodexInstallation: () => codexInstallation };
}

export async function resolveProjectRuntimeRoot(rootPath: string, protectedRoots: readonly string[]) {
  const resolved = path.resolve(rootPath);
  const value = await stat(resolved).catch(() => undefined);
  if (!value?.isDirectory()) throw new Error('PROJECT_WORKSPACE_NOT_READY');
  await assertCanonicalPathOutsideProtectedRoots(resolved, protectedRoots);
  return realpath(resolved);
}
