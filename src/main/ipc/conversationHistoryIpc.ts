import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ConversationDeleteRequest } from '../../shared/conversationLifecycle';
import { assertSingleChatConversationSnapshots } from '../../shared/singleChatMessages';
import { assertHistoryImport, assertHistoryPage, assertHistorySearch, assertHistoryWrite, assertToolOutputRequest, type SingleChatHistoryStore } from '../conversation/SingleChatHistoryStore';
import { mergeLegacySingleChats } from '../conversation/singleChatHistoryProjection';
import type { ConversationDeletionService } from '../conversation/ConversationDeletionService';
import type { ConversationLifecycleService } from '../conversation/ConversationLifecycleService';
import type { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import type { PartnerDiarySettingsStore } from '../diary/PartnerDiarySettingsStore';
import type { PartnerDiaryScheduler } from '../diary/PartnerDiaryScheduler';
import type { MemoryFallbackInventory } from '../memory/fallback/MemoryFallbackInventory';

interface ConversationHistoryDependencies {
  conversationLifecycle: Pick<ConversationLifecycleService, 'delete'>;
  conversationDeletions: Pick<ConversationDeletionService, 'listDeletedIds' | 'isDeleted'>;
  singleChatHistory: Pick<SingleChatHistoryStore, 'open' | 'openRecent' | 'initialize' | 'previewSnapshotCleanup' | 'clearSnapshots' | 'readPage' | 'readToolOutput' | 'search' | 'write' | 'isActive'>;
  singleChatMessages: Pick<SingleChatMessageStore, 'listLegacy' | 'sync'>;
  nativeBindings: Pick<NativeThreadBindingStore, 'pendingCodexImports' | 'activate'>;
  diarySettings: Pick<PartnerDiarySettingsStore, 'reconcileSources'>;
  diaryScheduler: Pick<PartnerDiaryScheduler, 'changed'>;
  memoryFallbackInventory: Pick<MemoryFallbackInventory, 'refresh'>;
}

export function registerConversationHistoryIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { conversationLifecycle, conversationDeletions, singleChatHistory, singleChatMessages, nativeBindings, diarySettings, diaryScheduler, memoryFallbackInventory }: ConversationHistoryDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.conversationDelete, async (event, value: unknown) => {
    requireSender(event);
    const request = assertConversationDeleteRequest(value);
    return conversationLifecycle.delete(request);
  });
  ipcMain.handle(AGENT_IPC.conversationListDeleted, async (event) => {
    requireSender(event);
    return conversationDeletions.listDeletedIds();
  });
  const openSingleChatHistory = async (recent: unknown) => {
    if (recent !== undefined && typeof recent !== 'boolean') throw new Error('SINGLE_CHAT_HISTORY_INVALID_OPEN');
    const history = await (recent ? singleChatHistory.openRecent() : singleChatHistory.open());
    if (!history) return undefined;
    const deleted = new Set(await conversationDeletions.listDeletedIds());
    const conversations = history.conversations.filter(conversation => !deleted.has(conversation.id));
    const pending = await nativeBindings.pendingCodexImports();
    if (pending.length) {
      const committed = new Map(conversations.filter(conversation => conversation.importedCodexThread).map(conversation => [conversation.id, conversation]));
      for (const binding of pending) {
        const conversation = committed.get(binding.conversationId);
        if (conversation && binding.nativeThreadId && conversation.partnerId === binding.partnerId && conversation.sessionId === binding.nativeThreadId) {
          await nativeBindings.activate(binding.bindingId, binding.nativeThreadId);
        }
      }
    }
    return { ...history, conversations };
  };
  ipcMain.handle(AGENT_IPC.conversationOpenHistory, async (event, recent: unknown) => {
    requireSender(event);
    return openSingleChatHistory(recent);
  });
  ipcMain.handle(AGENT_IPC.conversationPreviewSnapshotCleanup, async (event) => {
    requireSender(event);
    return singleChatHistory.previewSnapshotCleanup();
  });
  ipcMain.handle(AGENT_IPC.conversationClearSnapshots, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string' || value.length !== 36) throw new Error('SNAPSHOT_PLAN_EXPIRED');
    return singleChatHistory.clearSnapshots(value);
  });
  ipcMain.handle(AGENT_IPC.conversationMigrateHistory, async (event, value: unknown, recent: unknown) => {
    requireSender(event);
    if (recent !== undefined && typeof recent !== 'boolean') throw new Error('SINGLE_CHAT_HISTORY_INVALID_OPEN');
    await singleChatHistory.initialize(async () => {
      assertHistoryImport(value);
      const [projection, deletedConversationIds] = await Promise.all([singleChatMessages.listLegacy(), conversationDeletions.listDeletedIds()]);
      return {
        profile: value.profile,
        conversations: mergeLegacySingleChats(value.conversations, projection),
        deletedConversationIds,
      };
    });
    const history = await openSingleChatHistory(recent);
    if (!history) throw new Error('SINGLE_CHAT_HISTORY_ACTIVATION_MISSING');
    return history;
  });
  ipcMain.handle(AGENT_IPC.conversationReadHistoryPage, async (event, value: unknown) => {
    requireSender(event);
    assertHistoryPage(value);
    if (await conversationDeletions.isDeleted(value.conversationId)) return undefined;
    return singleChatHistory.readPage(value);
  });
  ipcMain.handle(AGENT_IPC.conversationReadToolOutput, async (event, value: unknown) => {
    requireSender(event);
    assertToolOutputRequest(value);
    if (await conversationDeletions.isDeleted(value.conversationId)) return undefined;
    return singleChatHistory.readToolOutput(value);
  });
  ipcMain.handle(AGENT_IPC.conversationSearchHistory, async (event, value: unknown) => {
    requireSender(event);
    assertHistorySearch(value);
    const result = await singleChatHistory.search(value);
    const deleted = new Set(await conversationDeletions.listDeletedIds());
    return {
      ...result,
      conversationIds: result.conversationIds.filter(id => !deleted.has(id)),
      messageIds: value.conversationId && deleted.has(value.conversationId) ? [] : result.messageIds,
      hasMore: result.hasMore && (!value.conversationId || !deleted.has(value.conversationId)),
    };
  });
  ipcMain.handle(AGENT_IPC.conversationWriteHistory, async (event, value: unknown) => {
    requireSender(event);
    assertHistoryWrite(value);
    const deleted = new Set(await conversationDeletions.listDeletedIds());
    if (value.changes.some(change => deleted.has(change.conversationId) && change.upsert.some(message => message.status === 'sending'))) {
      throw new Error('SINGLE_CHAT_HISTORY_CONVERSATION_DELETED');
    }
    const changes = value.changes.filter(change => !deleted.has(change.conversationId));
    await singleChatHistory.write({ ...value, changes });
    if (changes.some(change => change.busy === false && (change.upsert.length || change.remove.length))) {
      void memoryFallbackInventory.refresh().catch(() => undefined);
    }
    if (changes.some(change => change.busy === false && (change.upsert.length || change.metadata?.isArchived || change.metadata?.isDisabled))) {
      void diarySettings.reconcileSources().then(() => diaryScheduler.changed()).catch(() => undefined);
    }
  });
  ipcMain.handle(AGENT_IPC.conversationSyncMessages, async (event, value: unknown) => {
    requireSender(event);
    if (await singleChatHistory.isActive()) return;
    assertSingleChatConversationSnapshots(value);
    await singleChatMessages.sync(value);
    await diarySettings.reconcileSources(); await diaryScheduler.changed();
    await memoryFallbackInventory.refresh();
  });
}

function assertConversationDeleteRequest(value: unknown): ConversationDeleteRequest {
  if (!isRecord(value) || typeof value.conversationId !== 'string' || typeof value.partnerId !== 'string'
    || !['existing_thread', 'local_cli', 'api_partner'].includes(String(value.source))) {
    throw new Error('INVALID_CONVERSATION_DELETE');
  }
  return value as unknown as ConversationDeleteRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
