// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import type { ApiProviderAdapter } from '../../src/main/api/ApiProviderAdapter';
import type { MemoryImportService } from '../../src/main/memory/MemoryImportService';
import { PartnerMemoryService } from '../../src/main/memory/PartnerMemoryService';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import type { MemoryImportPreview } from '../../src/shared/memoryImport';
import { testRm } from '../helpers/autoTest.mjs';

const fixture = vi.hoisted(() => ({
  root: '',
  partnerId: 'fixture-memory-partner',
  stream: vi.fn<ApiProviderAdapter['stream']>(),
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => fixture.root,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: async () => undefined,
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: {},
}));
vi.mock('../../src/main/memory/MemoryImportService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/memory/MemoryImportService')>();
  return {
    ...actual,
    MemoryImportService: class extends actual.MemoryImportService {
      constructor(memories: ConstructorParameters<typeof MemoryImportService>[0]) {
        super(memories, id => id === fixture.partnerId, async () => ({
          provider: 'fixture', stream: fixture.stream,
          capabilities: {
            streamingText: true, reasoning: false, toolCalls: false,
            attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' },
          },
        }));
      }
    },
  };
});

it('previews, cancels, confirms selected memories, and undoes only untouched imports through IPC', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mi-'));
  fixture.root = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, request: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const preview = 'asterium:memory-import:preview';
  const confirm = 'asterium:memory-import:confirm';
  const cancel = 'asterium:memory-import:cancel';
  const undo = 'asterium:memory-import:undo';
  const invoke = async <T = unknown>(channel: string, request: unknown, caller: object = sender): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return await handler({ sender: caller }, request) as T;
  };

  try {
    const partnerId = fixture.partnerId;
    const profiles = new PartnerProfileStore(path.join(root, 'AsteriumData'));
    await profiles.savePartner({
      partnerId, sourceMode: 'local_cli',
      publicIdentity: { displayName: 'Fixture partner', mentionName: 'fixture', introduction: '', expertise: '' },
      management: { userProfile: false, personality: false, memoryMode: 'asterium' },
      connectionSettings: {},
    });
    const memories = new PartnerMemoryService(profiles);
    const canceledBatch = { partnerId, batchId: randomUUID() };
    const importInput = {
      label: 'fixture-dialogue.md', text: '示例用户：登记合成资料。\n\n示例用户：先审阅再提交，报告使用 Markdown。',
      endpoint: 'https://example.invalid', provider: 'fixture', model: 'fixture-model',
    };
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      for (const channel of [preview, confirm, cancel, undo]) {
        await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
        await expect(invoke(channel, null)).rejects.toMatchObject({ name: 'ZodError' });
      }
      fixture.stream.mockImplementationOnce(async function* ({ signal }) {
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        signal.throwIfAborted();
        yield { type: 'text.delta', text: '[]' };
      });
      const pending = invoke(preview, { ...importInput, ...canceledBatch })
        .then(result => ({ result }), (error: unknown) => ({ error }));
      await vi.waitFor(() => expect(fixture.stream).toHaveBeenCalledOnce(), { timeout: 3000 });
      await expect(invoke(cancel, canceledBatch)).resolves.toBeUndefined();
      await expect(pending).resolves.toMatchObject({ error: { name: 'AbortError' } });
      expect(fixture.stream.mock.calls[0][0].signal.aborted).toBe(true);
      await expect(memories.list(partnerId)).resolves.toEqual([]);

      const batch = { partnerId, batchId: randomUUID() };
      fixture.stream.mockImplementationOnce(async function* () {
        yield { type: 'text.delta', text: JSON.stringify([
          { type: 'stable_fact', body: '登记合成资料。', paragraph: 1 },
          { type: 'preference_and_collaboration', body: '先审阅再提交。', paragraph: 2 },
          { type: 'stable_fact', body: '报告使用 Markdown。', paragraph: 2 },
        ]) };
      });
      const draft = await invoke<MemoryImportPreview>(preview, { ...importInput, ...batch });
      expect(draft.candidates).toHaveLength(3);
      await expect(memories.list(partnerId)).resolves.toEqual([]);
      const selected = draft.candidates.slice(0, 2).map(({ id, type, body }) => ({ id, type, body }));
      await expect(invoke(confirm, { ...batch, selected })).resolves.toEqual({ added: 2, skipped: 0 });
      const imported = await memories.list(partnerId);
      expect(imported.map(record => record.body).sort()).toEqual(selected.map(record => record.body).sort());
      await memories.update(partnerId, { ...imported[0], body: '人工编辑后的合成记忆。' });
      await expect(invoke(undo, batch)).resolves.toEqual({ removed: 1, retained: 1 });
      expect((await memories.list(partnerId)).map(record => record.body)).toEqual(['人工编辑后的合成记忆。']);
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});
