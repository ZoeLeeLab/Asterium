// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { ApiConnectionStore } from '../../src/main/api/ApiConnectionStore';
import { CredentialStore } from '../../src/main/security/CredentialStore';
import type { ApiConfigurationMutation } from '../../src/shared/apiConnections';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({
  root: '',
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.root,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: async () => undefined,
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: electron.safeStorage,
  shell: {},
}));

const channel = 'asterium:api-connections:probe';
const modelId = 'fixture-probe-model';
const otherModelId = 'fixture-other-model';
const toolName = 'asterium_connection_probe';
const roundTimeoutMs = 1_500;
const service = {
  id: 'fixture-service', name: 'Fixture service', protocol: 'chat_completions',
  endpoint: 'https://probe.fixture.invalid/v1', credentialRef: 'fixture-provider-ref',
  settings: { roundTimeoutMs, headers: [{ name: 'X-Fixture-Header', credentialRef: 'fixture-header-ref' }] },
} satisfies Extract<ApiConfigurationMutation, { action: 'service' }>['value'];
const result = { text: 'Fixture reply', toolCall: false };

function streamResponse(...deltas: object[]) {
  return new Response(
    deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`).join('')
      + 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function holdNextRequest(fetcher: FetchMock) {
  let start!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>(resolve => { start = resolve; });
  fetcher.mockImplementationOnce((_url, init) => {
    start(init!.signal!);
    return new Promise<Response>(() => {});
  });
  return started;
}

async function withProbe(run: (fixture: {
  invoke: (value: unknown, caller?: object) => Promise<unknown>;
  fetcher: FetchMock;
  credentials: CredentialStore;
  dispose: () => Promise<void>;
}) => Promise<void>) {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-api-probe-ipc-'));
  electron.root = root;
  const credentials = new CredentialStore(path.join(root, 'secure-credentials.v1.json'), electron.safeStorage);
  const connections = new ApiConnectionStore(path.join(root, 'api-connections.v1.json'));
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, request: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, handler: Handler) => {
      if (handlers.has(name)) throw new Error(`Duplicate IPC channel: ${name}`);
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain;
  const invoke = (value: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };

  const fetcher = vi.fn<typeof fetch>(async () => streamResponse({ content: result.text }));
  vi.stubGlobal('fetch', fetcher);
  try {
    await credentials.save('synthetic-probe-key', service.credentialRef);
    await credentials.save('synthetic-probe-header', service.settings.headers[0].credentialRef);
    await connections.mutate({ action: 'service', expectedRevision: 0, value: service });
    for (const [index, id] of [modelId, otherModelId].entries()) {
      await connections.mutate({
        action: 'model', expectedRevision: index + 1,
        value: { id, serviceId: service.id, name: 'Fixture model', model: id, tools: true, images: false, settings: { autoCompact: false, temperature: 0.25 } },
      });
    }
    const closeAgent = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    let closing: Promise<void> | undefined;
    const dispose = () => closing ??= closeAgent();
    try {
      await run({ invoke, fetcher, credentials, dispose });
    } finally {
      await dispose();
    }
    expect(handlers.has(channel)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    await testRm(root, { recursive: true, force: true });
  }
}

it('probes the configured model with text or the synthetic tool and preserves the result format', async () => {
  await withProbe(async ({ invoke, fetcher }) => {
    expect(fetcher).not.toHaveBeenCalled();
    const tool = (name: string) => ({ tool_calls: [{ index: 0, function: { name, arguments: '{"value":"ok"}' } }] });
    fetcher.mockResolvedValueOnce(streamResponse({ content: 'a'.repeat(1_500) }, { content: 'b'.repeat(600) }, tool('fixture-unrelated-tool')));
    await expect(invoke({ modelId, tools: false })).resolves.toEqual({ text: 'a'.repeat(1_500) + 'b'.repeat(500), toolCall: false });
    fetcher.mockResolvedValueOnce(streamResponse({ content: result.text }, tool(toolName)));
    await expect(invoke({ modelId, tools: true })).resolves.toEqual({ text: result.text, toolCall: true });

    const [[url, textRequest], [, toolRequest]] = fetcher.mock.calls;
    expect(url).toBe('https://probe.fixture.invalid/v1/chat/completions');
    expect(textRequest).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-probe-key', 'X-Fixture-Header': 'synthetic-probe-header' },
    });
    const textBody = JSON.parse(String(textRequest?.body));
    expect(textBody).toMatchObject({
      model: modelId, temperature: 0.25,
      messages: [{ role: 'user', content: 'This is a connection test. Reply briefly: OK.' }],
    });
    expect(textBody).not.toHaveProperty('tools');
    expect(JSON.parse(String(toolRequest?.body))).toMatchObject({
      messages: [{ role: 'user', content: `Call ${toolName} once with value "ok". Do not call any other tool.` }],
      tools: [{ type: 'function', function: { name: toolName, parameters: { required: ['value'], additionalProperties: false } } }],
    });
  });
});

it('keeps validation, credential and provider errors and permits an explicit retry', async () => {
  await withProbe(async ({ invoke, fetcher, credentials }) => {
    await expect(invoke({ modelId }, {})).rejects.toThrow('INVALID_IPC_SENDER');
    for (const invalid of [null, { modelId: 1 }, { modelId, tools: 'yes' }]) {
      await expect(invoke(invalid)).rejects.toThrow('INVALID_API_PROBE');
    }
    await expect(invoke({ modelId: 'unknown' })).rejects.toThrow('API_MODEL_NOT_FOUND');
    await credentials.delete(service.credentialRef);
    await expect(invoke({ modelId })).rejects.toThrow('API_CREDENTIAL_REQUIRED');
    await credentials.save('synthetic-probe-key', service.credentialRef);
    const headerRef = service.settings.headers[0].credentialRef;
    await credentials.delete(headerRef);
    await expect(invoke({ modelId })).rejects.toThrow('API_HEADER_CREDENTIAL_REQUIRED');
    await credentials.save('synthetic-probe-header', headerRef);
    expect(fetcher).not.toHaveBeenCalled();

    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(invoke({ modelId })).rejects.toThrow('API_PROBE_FAILED');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(invoke({ modelId })).resolves.toEqual(result);
  });
});

it('rejects overlapping probes for the same model and allows other models and manual cancellation', async () => {
  await withProbe(async ({ invoke, fetcher }) => {
    const started = holdNextRequest(fetcher);
    const failure = expect(invoke({ modelId })).rejects.toThrow('API_PROBE_FAILED');
    const signal = await started;
    await expect(invoke({ modelId, tools: true })).rejects.toThrow('API_PROBE_BUSY');
    await expect(invoke({ modelId: otherModelId })).resolves.toEqual(result);
    expect(signal.aborted).toBe(false);
    await expect(invoke({ modelId, cancel: true })).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    await failure;
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(invoke({ modelId })).resolves.toEqual(result);
  });
});

it('aborts at the configured round timeout and releases the model for another probe', async () => {
  await withProbe(async ({ invoke, fetcher }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const started = holdNextRequest(fetcher);
      const failure = expect(invoke({ modelId })).rejects.toThrow('API_PROBE_FAILED');
      const signal = await started;
      await vi.advanceTimersByTimeAsync(roundTimeoutMs - 1);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      await failure;
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(invoke({ modelId })).resolves.toEqual(result);
    } finally {
      vi.useRealTimers();
    }
  });
});

it('aborts all in-flight probes during agent IPC disposal and removes the channel', async () => {
  await withProbe(async ({ invoke, fetcher, dispose }) => {
    const firstStarted = holdNextRequest(fetcher);
    const firstFailure = expect(invoke({ modelId })).rejects.toThrow('API_PROBE_FAILED');
    const firstSignal = await firstStarted;
    const secondStarted = holdNextRequest(fetcher);
    const secondFailure = expect(invoke({ modelId: otherModelId })).rejects.toThrow('API_PROBE_FAILED');
    const secondSignal = await secondStarted;
    expect(firstSignal.aborted).toBe(false);
    expect(secondSignal.aborted).toBe(false);
    await dispose();
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(true);
    await Promise.all([firstFailure, secondFailure]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
