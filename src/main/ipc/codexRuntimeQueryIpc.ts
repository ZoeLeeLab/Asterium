import { access } from 'node:fs/promises';
import os from 'node:os';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { CodexRuntimeInfo } from '../../shared/agentProtocol';
import type { CodexModelListRequest } from '../../shared/codexModels';
import type { CodexQuotaResult } from '../../shared/codexQuota';
import { resolveCodexRuntime } from '../../shared/codexRuntimeSelection';
import { CODEX_IMPORTED_DIRECTORY_UNAVAILABLE, type ImportedCodexWorkspace } from '../../shared/codexThreadImport';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { listCodexModels, readCodexQuota, type CodexInstallation } from '../adapters/CodexCliAdapter';
import { sameCodexPath } from '../adapters/codexSessionFile';
import type { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';

interface CodexRuntimeQueryDependencies {
  studioRuntimeCatalog: Pick<StudioRuntimeCatalog, 'partner'>;
  importedCodexBinding(partnerId: string, conversationId: string): Promise<{ workspace: ImportedCodexWorkspace } | undefined>;
  resolveImportedCodexRuntime(workspace: ImportedCodexWorkspace): Promise<CodexRuntimeInfo>;
  availableImportedDirectory(directory: string, canonicalDirectory?: string): Promise<string | undefined>;
  resolveCodexLifecycleRuntime(request: CodexModelListRequest): Promise<{ runtime: CodexRuntimeInfo; workingDirectory: string }>;
  currentCodexInstallation(): CodexInstallation | undefined;
  ensureCodexInstallation(): Promise<CodexInstallation>;
  refreshCodexInstallation(): Promise<CodexInstallation>;
}

export function registerCodexRuntimeQueryIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  dependencies: CodexRuntimeQueryDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  const {
    studioRuntimeCatalog, importedCodexBinding, resolveImportedCodexRuntime, availableImportedDirectory, resolveCodexLifecycleRuntime,
    currentCodexInstallation, ensureCodexInstallation, refreshCodexInstallation,
  } = dependencies;

  ipcMain.handle(AGENT_IPC.listCodexModels, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || (value.partnerRootGrantId !== undefined && typeof value.partnerRootGrantId !== 'string')
      || (value.conversationId !== undefined && typeof value.conversationId !== 'string')
      || (value.partnerId !== undefined && typeof value.partnerId !== 'string')
      || (value.codexRuntimeId !== undefined && typeof value.codexRuntimeId !== 'string')
      || (value.codexRuntimeEnvironment !== undefined && !['global_cli', 'desktop_app', 'vscode_extension', 'path'].includes(String(value.codexRuntimeEnvironment)))) {
      throw new Error('INVALID_CODEX_MODEL_LIST_REQUEST');
    }
    if (typeof value.conversationId === 'string' && typeof value.partnerId === 'string') {
      const imported = await importedCodexBinding(value.partnerId, value.conversationId);
      if (imported) {
        const runtime = await resolveImportedCodexRuntime(imported.workspace);
        const directory = await availableImportedDirectory(imported.workspace.directory, imported.workspace.canonicalDirectory);
        if (!directory) throw new Error(CODEX_IMPORTED_DIRECTORY_UNAVAILABLE);
        return listCodexModels(runtime.executablePath, directory);
      }
    }
    const { runtime, workingDirectory } = await resolveCodexLifecycleRuntime(value as CodexModelListRequest);
    return listCodexModels(runtime.executablePath, workingDirectory);
  });

  const codexQuotaRequests = new Map<string, Promise<CodexQuotaResult>>();
  ipcMain.handle(AGENT_IPC.readCodexQuota, async (event, value: unknown): Promise<CodexQuotaResult> => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId.trim() || value.partnerId.length > 512
      || (value.importedConversationId !== undefined && (typeof value.importedConversationId !== 'string'
        || !value.importedConversationId.trim() || value.importedConversationId.length > 512))) {
      throw new Error('INVALID_CODEX_QUOTA_REQUEST');
    }
    const partner = studioRuntimeCatalog.partner(value.partnerId);
    if (!partner?.available || partner.runtime.kind !== 'local' || partner.runtime.adapterType !== 'codex_cli') {
      return { status: 'runtime_unavailable' };
    }
    const imported = value.importedConversationId
      ? await importedCodexBinding(partner.partnerId, value.importedConversationId)
      : undefined;
    if (value.importedConversationId && !imported) return { status: 'runtime_unavailable' };

    const runtimeId = imported ? imported.workspace.runtimeId : partner.runtime.codexRuntimeId;
    const environment = imported ? imported.workspace.runtimeEnvironment : partner.runtime.codexRuntimeEnvironment;
    if (!runtimeId && !environment) return { status: 'runtime_unavailable' };
    const select = ({ runtimes }: CodexInstallation) => resolveCodexRuntime(runtimes, runtimeId, environment);
    const hadCachedRuntimes = Boolean(currentCodexInstallation()?.runtimes.length);
    let runtime = select(await ensureCodexInstallation());
    const stillInstalled = runtime && await access(runtime.executablePath).then(() => true, () => false);
    if (!stillInstalled && hadCachedRuntimes) {
      runtime = select(await refreshCodexInstallation());
    }
    if (!runtime || (imported && !sameCodexPath(runtime.codexHome, imported.workspace.codexHome))) {
      return { status: 'runtime_unavailable' };
    }

    const key = runtime.runtimeId;
    const existing = codexQuotaRequests.get(key);
    if (existing) return existing;
    // Quota is account-scoped. The request does not need a project or a native thread.
    const request = readCodexQuota(runtime.executablePath, os.homedir()).finally(() => codexQuotaRequests.delete(key));
    codexQuotaRequests.set(key, request);
    return request;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
