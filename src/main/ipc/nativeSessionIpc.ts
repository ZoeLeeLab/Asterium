import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { ChangeLocalThreadLifecycleRequest, CodexRuntimeInfo, LocalThreadLifecycleRequest, NativeThreadLifecycleResult } from '../../shared/agentProtocol';
import type { CodexThreadDirectoryPreview, CodexThreadImportPreview, CodexThreadImportResult, ImportedCodexWorkspace } from '../../shared/codexThreadImport';
import type { NativeThreadBinding } from '../../shared/studioRuntime';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { changeCodexThreadLifecycle, getCodexThreadLifecyclesSafely, getImportedCodexThreadLifecycle, locateCodexHistoryTurn, readCodexThreadMetadata, readCodexThreadsMetadata, readCodexThreadHistory, searchCodexThreadHistory } from '../adapters/CodexCliAdapter';
import { codexSessionDirectoryDate, readCodexSessionDirectory, readCodexSessionHeader, sameCodexPath, sameCodexSessionRecord } from '../adapters/codexSessionFile';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import type { ConversationDeletionService } from '../conversation/ConversationDeletionService';
import type { SingleChatHistoryStore } from '../conversation/SingleChatHistoryStore';
import type { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import type { PartnerProfileStore } from '../partner/PartnerProfileStore';
import type { WriterLeaseCoordinator } from '../runtime/WriterLeaseCoordinator';
import type { PartnerWorkspaceStore } from '../security/PartnerWorkspaceStore';

type LocalAdapterType = 'claude_code' | 'codex_cli';
type ImportedBinding = { binding: NativeThreadBinding; workspace: ImportedCodexWorkspace };

interface NativeRuntimeResolvers {
  importedCodexBinding(partnerId: string, conversationId: string, threadId?: string): Promise<ImportedBinding | undefined>;
  resolveImportedCodexRuntime(workspace: ImportedCodexWorkspace): Promise<CodexRuntimeInfo>;
  resolveCodexLifecycleRuntime(value: Pick<LocalThreadLifecycleRequest, 'partnerRootGrantId' | 'codexRuntimeId' | 'codexRuntimeEnvironment'>): Promise<{ runtime: CodexRuntimeInfo; workingDirectory: string }>;
}

interface NativeSingleBindingDependencies {
  conversationDeletions: Pick<ConversationDeletionService, 'isDeleted'>;
  singleChatHistory: Pick<SingleChatHistoryStore, 'isActive' | 'readMetadata'>;
  nativeBindings: Pick<NativeThreadBindingStore, 'getForScope' | 'registerSingle'>;
}

export function registerNativeSingleBindingIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { conversationDeletions, singleChatHistory, nativeBindings }: NativeSingleBindingDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.nativeSyncSingleBindings, async (event, value: unknown) => {
    requireSender(event);
    if (!Array.isArray(value)) throw new Error('INVALID_SINGLE_BINDING_SYNC');
    for (const item of value) {
      if (!isRecord(item) || typeof item.partnerId !== 'string' || typeof item.conversationId !== 'string' || typeof item.nativeThreadId !== 'string'
        || !['local_cli', 'api_partner'].includes(String(item.source))) throw new Error('INVALID_SINGLE_BINDING_SYNC');
      if (await conversationDeletions.isDeleted(item.conversationId)) continue;
      if (await singleChatHistory.isActive()) {
        const committed = await singleChatHistory.readMetadata(item.conversationId);
        if (!committed || committed.partnerId !== item.partnerId || committed.sessionId !== item.nativeThreadId) continue;
        if (committed.importedCodexThread && !(await nativeBindings.getForScope(item.partnerId, 'single', item.conversationId))?.importedCodexWorkspace) continue;
      }
      await nativeBindings.registerSingle({
        partnerId: item.partnerId,
        conversationId: item.conversationId,
        nativeThreadId: item.nativeThreadId,
        source: item.source as 'local_cli' | 'api_partner',
      });
    }
  });

}

interface NativeSessionImportDependencies extends Pick<NativeRuntimeResolvers, 'importedCodexBinding'> {
  nativeBindings: Pick<NativeThreadBindingStore, 'reserveCodexImport' | 'activate' | 'updateImportedCodexDirectory'>;
  singleChatHistory: Pick<SingleChatHistoryStore, 'readMetadata' | 'createImportedCodexConversation'>;
  conversationDeletions: Pick<ConversationDeletionService, 'isDeleted'>;
  studioRuntimeCatalog: Pick<StudioRuntimeCatalog, 'partner'>;
  partnerProfiles: Pick<PartnerProfileStore, 'runtimeProfile'>;
  writerLeases: Pick<WriterLeaseCoordinator, 'tryAcquire'>;
  resolveCodexDirectoryRuntime(runtimeId?: string, environment?: CodexRuntimeInfo['environment'], codexHome?: string): Promise<CodexRuntimeInfo>;
  availableImportedDirectory(directory: string, canonicalDirectory?: string): Promise<string | undefined>;
}

export function registerNativeSessionImportIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { nativeBindings, singleChatHistory, conversationDeletions, studioRuntimeCatalog, partnerProfiles, writerLeases,
    resolveCodexDirectoryRuntime, availableImportedDirectory, importedCodexBinding }: NativeSessionImportDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  type CodexImportSelection = {
    file: string;
    preview: CodexThreadImportPreview;
    canonicalDirectory?: string;
  };
  const codexImportSelections = new WeakMap<Electron.WebContents, {
    runtime: CodexRuntimeInfo;
    entries: Map<string, CodexImportSelection>;
  }>();

  const lastCodexImportDirectory = new WeakMap<Electron.WebContents, { codexHome: string; parent: string }>();

  async function validateCodexCurrentFile(runtime: CodexRuntimeInfo, threadId: string, nativeFile: string, cwd: string) {
    if (!path.isAbsolute(cwd) || !path.isAbsolute(nativeFile)) throw new Error('CODEX_THREAD_METADATA_INVALID');
    const { file, threadId: recordedId } = await readCodexSessionHeader(nativeFile, runtime.codexHome);
    if (threadId !== recordedId) throw new Error('CODEX_THREAD_METADATA_INVALID');
    return file;
  }

  ipcMain.handle(AGENT_IPC.chooseCodexThreadDirectory, async (event, value: unknown): Promise<CodexThreadDirectoryPreview | null> => {
    const window = requireSender(event);
    if (!isRecord(value) || (value.runtimeId !== undefined && typeof value.runtimeId !== 'string')
      || (value.codexHome !== undefined && (typeof value.codexHome !== 'string' || !path.isAbsolute(value.codexHome)))) {
      throw new Error('CODEX_RUNTIME_SELECTION_REQUIRED');
    }
    const environment = value.runtimeEnvironment;
    if (environment !== undefined && environment !== 'global_cli' && environment !== 'desktop_app'
      && environment !== 'vscode_extension' && environment !== 'path') throw new Error('CODEX_RUNTIME_SELECTION_REQUIRED');
    codexImportSelections.delete(event.sender);
    const runtime = await resolveCodexDirectoryRuntime(value.runtimeId, environment, value.codexHome);
    const lastDirectory = lastCodexImportDirectory.get(event.sender);
    const defaultPath = lastDirectory && sameCodexPath(lastDirectory.codexHome, runtime.codexHome)
      && await stat(lastDirectory.parent).then(entry => entry.isDirectory(), () => false)
      ? lastDirectory.parent : path.join(runtime.codexHome, 'sessions');
    const result = await dialog.showOpenDialog(window, {
      title: '选择 Codex 线程的年、月或日文件夹',
      buttonLabel: '读取线程',
      defaultPath,
      properties: ['openDirectory', 'showHiddenFiles', 'dontAddToRecent'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = await readCodexSessionDirectory(result.filePaths[0], runtime.codexHome);
    lastCodexImportDirectory.set(event.sender, { codexHome: runtime.codexHome, parent: path.dirname(directory.directory) });
    const entries = new Map<string, CodexImportSelection>();
    const threadIds = [...directory.filesByThreadId.keys()];
    const records = threadIds.length
      ? await readCodexThreadsMetadata(runtime.executablePath, os.homedir(), threadIds) : [];
    for (const { threadId, metadata } of records) {
      if (!metadata) continue;
      try {
        const { cwd, title, updatedAt } = metadata;
        const file = await validateCodexCurrentFile(runtime, threadId, metadata.file, cwd);
        const canonicalDirectory = await availableImportedDirectory(cwd);
        const matchingFiles = directory.filesByThreadId.get(threadId) ?? [];
        const currentRecord = matchingFiles.some(candidate => sameCodexPath(candidate, file)) ? undefined
          : { date: codexSessionDirectoryDate(path.dirname(file), directory.sessions) };
        const preview: CodexThreadImportPreview = {
          selectionId: randomUUID(), threadId, title, cwd, updatedAt, directoryAvailable: Boolean(canonicalDirectory), currentRecord,
        };
        entries.set(preview.selectionId, { file, preview, canonicalDirectory });
      } catch {
        // A bad record does not hide other threads from the selected period.
      }
    }
    const threads = [...entries.values()].map(({ preview }) => preview)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.title.localeCompare(b.title, 'zh-CN'));
    codexImportSelections.set(event.sender, { runtime, entries });
    return { date: directory.date, threads, unavailableCount: directory.unavailableCount + threadIds.length - entries.size };
  });

  ipcMain.handle(AGENT_IPC.confirmCodexThreadImport, async (event, value: unknown): Promise<CodexThreadImportResult> => {
    requireSender(event);
    if (!isRecord(value) || typeof value.selectionId !== 'string' || typeof value.partnerId !== 'string'
      || (value.permissionMode !== 'read_only' && value.permissionMode !== 'manual' && value.permissionMode !== 'automatic' && value.permissionMode !== 'full')) throw new Error('INVALID_CODEX_THREAD_IMPORT');
    const batch = codexImportSelections.get(event.sender);
    const selection = batch?.entries.get(value.selectionId);
    if (!batch || !selection) throw new Error('请重新选择 Codex 日期文件夹及线程。');
    const partner = studioRuntimeCatalog.partner(value.partnerId);
    if (!partner?.available || partner.runtime.kind !== 'local' || partner.runtime.adapterType !== 'codex_cli'
      || !await partnerProfiles.runtimeProfile(value.partnerId)) throw new Error('请先保存本地 Codex 伙伴。');
    const { runtime } = batch;
    const { preview } = selection;
    const current = await readCodexThreadMetadata(runtime.executablePath, os.homedir(), preview.threadId);
    const currentFile = await validateCodexCurrentFile(runtime, preview.threadId, current.file, current.cwd);
    if (!sameCodexSessionRecord(currentFile, selection.file)) throw new Error('Codex 当前使用的记录已变化，请重新选择日期文件夹。');
    const canonicalDirectory = await availableImportedDirectory(current.cwd);
    if (!sameCodexPath(current.cwd, preview.cwd)
      || (canonicalDirectory && (!selection.canonicalDirectory || !sameCodexPath(canonicalDirectory, selection.canonicalDirectory)))) {
      throw new Error('原线程的目录已变化，请重新选择并确认。');
    }
    const binding = await nativeBindings.reserveCodexImport(value.partnerId, preview.threadId, {
      originalCwd: preview.cwd, directory: preview.cwd, canonicalDirectory: selection.canonicalDirectory, runtimeId: runtime.runtimeId,
      runtimeEnvironment: runtime.environment, codexHome: runtime.codexHome,
    });
    if (binding.scope !== 'single' || binding.source !== 'local_cli') return { kind: 'bound_elsewhere', scope: binding.scope };
    if (binding.state === 'active') {
      const metadata = await singleChatHistory.readMetadata(binding.conversationId);
      if (!metadata || metadata.partnerId !== binding.partnerId || metadata.sessionId !== preview.threadId || await conversationDeletions.isDeleted(binding.conversationId)) {
        throw new Error('原线程已有绑定，但对应单聊暂不可用。');
      }
      return { kind: 'conversation', conversation: { ...metadata, messages: [] } };
    }
    if (binding.partnerId !== value.partnerId || !binding.importedCodexWorkspace) {
      return { kind: 'bound_elsewhere', scope: binding.scope };
    }
    const metadata = await singleChatHistory.createImportedCodexConversation({
      id: binding.conversationId, partnerId: binding.partnerId, sessionId: preview.threadId,
      title: preview.title, updatedAt: new Date().toISOString(), importedCodexThread: true,
      nativeThreadState: 'active', permissionMode: value.permissionMode, planMode: 'default',
    });
    await nativeBindings.activate(binding.bindingId, preview.threadId);
    return { kind: 'conversation', conversation: { ...metadata, messages: [] } };
  });

  ipcMain.handle(AGENT_IPC.codexImportedWorkspaceStatus, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || typeof value.conversationId !== 'string') throw new Error('INVALID_CODEX_IMPORTED_WORKSPACE');
    const imported = await importedCodexBinding(value.partnerId, value.conversationId);
    if (!imported) throw new Error('INVALID_CODEX_IMPORTED_WORKSPACE');
    const { directory, canonicalDirectory } = imported.workspace;
    return { directory, available: Boolean(await availableImportedDirectory(directory, canonicalDirectory)) };
  });

  ipcMain.handle(AGENT_IPC.chooseCodexImportedDirectory, async (event, value: unknown) => {
    const window = requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || typeof value.conversationId !== 'string') throw new Error('INVALID_CODEX_IMPORTED_WORKSPACE');
    const imported = await importedCodexBinding(value.partnerId, value.conversationId);
    if (!imported) throw new Error('INVALID_CODEX_IMPORTED_WORKSPACE');
    const { workspace, binding } = imported;
    const result = await dialog.showOpenDialog(window, {
      title: '重新选择目录', buttonLabel: '使用此目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = result.filePaths[0];
    const canonical = await availableImportedDirectory(directory);
    if (!canonical) throw new Error('该目录不可访问，请选择有效的项目目录。');
    const lease = writerLeases.tryAcquire({ kind: 'conversation', partnerId: binding.partnerId, conversationId: binding.conversationId }, `codex-directory:${randomUUID()}`);
    if (!lease) throw new Error('CODEX_IMPORTED_CONVERSATION_BUSY');
    try {
      if (await conversationDeletions.isDeleted(binding.conversationId)) throw new Error('CODEX_IMPORTED_THREAD_MISMATCH');
      await nativeBindings.updateImportedCodexDirectory(binding.bindingId, workspace.directory, directory, canonical);
    } finally {
      lease.release();
    }
    return { directory, available: true };
  });

}

interface NativeSessionHistoryDependencies extends NativeRuntimeResolvers {
  nativeBindings: Pick<NativeThreadBindingStore, 'getForScope'>;
  conversationDeletions: Pick<ConversationDeletionService, 'isDeleted'>;
  partnerWorkspaces: Pick<PartnerWorkspaceStore, 'grantIds'>;
}

export function registerNativeSessionHistoryIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { nativeBindings, conversationDeletions, partnerWorkspaces, importedCodexBinding,
    resolveImportedCodexRuntime, resolveCodexLifecycleRuntime }: NativeSessionHistoryDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  type CodexHistoryRequest = import('../../shared/codexHistory').CodexHistoryRequest;
  type CodexHistorySearchRequest = import('../../shared/codexHistory').CodexHistorySearchRequest;
  const assertCodexHistoryBinding = async (request: CodexHistoryRequest) => {
    const binding = await nativeBindings.getForScope(request.partnerId, 'single', request.conversationId);
    if (binding?.source !== 'local_cli' || binding.state !== 'active' || binding.nativeThreadId !== request.threadId
      || await conversationDeletions.isDeleted(request.conversationId)) throw new Error('CODEX_HISTORY_BINDING_UNAVAILABLE');
  };
  const resolveBoundCodexHistory = async (value: unknown) => {
    if (!isRecord(value) || typeof value.conversationId !== 'string' || !value.conversationId.trim() || value.conversationId.length > 512
      || typeof value.threadId !== 'string' || value.threadId.length > 512
      || (value.cursor !== undefined && !isCodexHistoryCursor(value.cursor))
      || (value.aroundTurnId !== undefined && (typeof value.aroundTurnId !== 'string' || !value.aroundTurnId.trim() || value.aroundTurnId.length > 512))
      || !isLocalThreadLifecycleRequest({ ...value, adapterType: 'codex_cli', threadIds: [value.threadId] })) {
      throw new Error('INVALID_CODEX_HISTORY_REQUEST');
    }
    const request = value as unknown as CodexHistoryRequest;
    await assertCodexHistoryBinding(request);
    const imported = await importedCodexBinding(request.partnerId, request.conversationId, request.threadId);
    if (imported) {
      const runtime = await resolveImportedCodexRuntime(imported.workspace);
      return { request, runtime, workingDirectory: os.homedir() };
    }
    const partnerRootGrantId = request.partnerRootGrantId ?? (await partnerWorkspaces.grantIds(request.partnerId))?.cwdGrantId;
    return { request, ...await resolveCodexLifecycleRuntime({ ...request, partnerRootGrantId }) };
  };

  ipcMain.handle(AGENT_IPC.readCodexHistory, async (event, value: unknown) => {
    requireSender(event);
    const { request, runtime, workingDirectory } = await resolveBoundCodexHistory(value);
    const page = request.aroundTurnId
      ? await locateCodexHistoryTurn(runtime.executablePath, workingDirectory, request.threadId, request.aroundTurnId, request.cursor)
      : await readCodexThreadHistory(runtime.executablePath, workingDirectory, request.threadId, request.cursor);
    await assertCodexHistoryBinding(request);
    return page;
  });

  const nativeHistorySearches = new WeakMap<Electron.WebContents, AbortController>();
  ipcMain.handle(AGENT_IPC.searchCodexHistory, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.query !== 'string' || value.query.length > 512
      || (value.after !== undefined && (!isRecord(value.after) || !Number.isSafeInteger(value.after.index)
        || Number(value.after.index) < 0 || Number(value.after.index) >= 60
        || (value.after.pageCursor !== undefined && !isCodexHistoryCursor(value.after.pageCursor))))) {
      throw new Error('INVALID_CODEX_HISTORY_SEARCH');
    }
    const { sender } = event;
    nativeHistorySearches.get(sender)?.abort();
    const cancellation = new AbortController();
    nativeHistorySearches.set(sender, cancellation);
    const onDestroy = () => cancellation.abort();
    sender.once('destroyed', onDestroy);
    try {
      const { request, runtime, workingDirectory } = await resolveBoundCodexHistory(value);
      const query = value as unknown as CodexHistorySearchRequest;
      const page = await searchCodexThreadHistory(runtime.executablePath, workingDirectory, query, cancellation.signal);
      cancellation.signal.throwIfAborted();
      await assertCodexHistoryBinding(request);
      return page;
    } finally {
      sender.removeListener('destroyed', onDestroy);
      if (nativeHistorySearches.get(sender) === cancellation) nativeHistorySearches.delete(sender);
    }
  });

}

export function registerNativeSessionLifecycleIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { importedCodexBinding, resolveImportedCodexRuntime, resolveCodexLifecycleRuntime }: NativeRuntimeResolvers,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.getLocalThreadLifecycles, async (event, value: unknown): Promise<NativeThreadLifecycleResult[]> => {
    requireSender(event);
    if (!isLocalThreadLifecycleRequest(value)) throw new Error('INVALID_LOCAL_THREAD_LIFECYCLE_REQUEST');
    if (value.adapterType === 'claude_code') return value.threadIds.map((threadId) => ({
      threadId,
      state: 'unsupported',
      checkedAt: new Date().toISOString(),
      message: '当前 Claude Code 桥接尚未提供原生线程归档同步。',
    }));
    if (value.conversationId && value.threadIds.length === 1) {
      const imported = await importedCodexBinding(value.partnerId, value.conversationId, value.threadIds[0]);
      if (imported) {
        const runtime = await resolveImportedCodexRuntime(imported.workspace);
        return [await getImportedCodexThreadLifecycle(runtime.executablePath, os.homedir(), runtime.codexHome, value.threadIds[0])];
      }
    }
    const { runtime, workingDirectory } = await resolveCodexLifecycleRuntime(value);
    return getCodexThreadLifecyclesSafely(runtime.executablePath, workingDirectory, value.threadIds);
  });

  ipcMain.handle(AGENT_IPC.changeLocalThreadLifecycle, async (event, value: unknown): Promise<NativeThreadLifecycleResult> => {
    requireSender(event);
    if (!isChangeLocalThreadLifecycleRequest(value)) throw new Error('INVALID_LOCAL_THREAD_LIFECYCLE_CHANGE_REQUEST');
    if (value.adapterType === 'claude_code') return {
      threadId: value.threadId,
      state: 'unsupported',
      checkedAt: new Date().toISOString(),
      message: '当前 Claude Code 桥接尚未提供原生线程归档、恢复或删除能力；星丛没有改动本地记录。',
    };
    const { runtime, workingDirectory } = await resolveCodexLifecycleRuntime(value);
    return changeCodexThreadLifecycle(runtime.executablePath, workingDirectory, value.threadId, value.action);
  });

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalAdapterType(value: unknown): value is LocalAdapterType {
  return value === 'claude_code' || value === 'codex_cli';
}

function isCodexHistoryCursor(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048;
}

function isLocalThreadLifecycleRequest(value: unknown): value is LocalThreadLifecycleRequest {
  return isRecord(value)
    && isLocalAdapterType(value.adapterType)
    && typeof value.partnerId === 'string'
    && value.partnerId.length > 0
    && (value.partnerRootGrantId === undefined || typeof value.partnerRootGrantId === 'string')
    && (value.codexRuntimeId === undefined || typeof value.codexRuntimeId === 'string')
    && (value.codexRuntimeEnvironment === undefined || ['global_cli', 'desktop_app', 'vscode_extension', 'path'].includes(String(value.codexRuntimeEnvironment)))
    && (value.conversationId === undefined || typeof value.conversationId === 'string')
    && Array.isArray(value.threadIds)
    && value.threadIds.length > 0
    && value.threadIds.every((threadId) => typeof threadId === 'string' && threadId.length > 0);
}

function isChangeLocalThreadLifecycleRequest(value: unknown): value is ChangeLocalThreadLifecycleRequest {
  return isRecord(value)
    && isLocalAdapterType(value.adapterType)
    && typeof value.partnerId === 'string'
    && value.partnerId.length > 0
    && (value.partnerRootGrantId === undefined || typeof value.partnerRootGrantId === 'string')
    && (value.codexRuntimeId === undefined || typeof value.codexRuntimeId === 'string')
    && (value.codexRuntimeEnvironment === undefined || ['global_cli', 'desktop_app', 'vscode_extension', 'path'].includes(String(value.codexRuntimeEnvironment)))
    && typeof value.threadId === 'string'
    && value.threadId.length > 0
    && ['archive', 'restore', 'delete'].includes(String(value.action));
}
