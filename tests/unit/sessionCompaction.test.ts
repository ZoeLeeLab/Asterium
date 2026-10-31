// @vitest-environment node
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCompactionService } from '../../src/main/runtime/SessionCompactionService';
import { WriterLeaseCoordinator, conversationWriterScope } from '../../src/main/runtime/WriterLeaseCoordinator';
import { assertSessionCompactRequest, type SessionCompactRequest } from '../../src/shared/sessionCompaction';
import { ApiAgentSessionStore, type ApiAgentSession } from '../../src/main/api/ApiAgentSessionStore';
import { compactApiSession } from '../../src/main/api/ApiSessionCompactor';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';
import { AGENT_PROTOCOL_VERSION } from '../../src/shared/agentProtocol';
import { AdapterHost } from '../../src/main/AdapterHost';
import { RunCoordinator } from '../../src/main/runtime/RunCoordinator';
import type { PartnerAdapter } from '../../src/main/adapters/PartnerAdapter';

const request: SessionCompactRequest = { commandId: 'compact-1', partnerId: 'p', conversationId: 'c', sessionId: 's', source: 'api_partner' };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) { const resolved = await realpath(root); expect(path.dirname(resolved).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase()); expect(path.basename(resolved)).toMatch(/^asterium-compact-test-/); await rm(resolved, { recursive: true, force: true }); }
});
async function store() { const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-compact-test-')); roots.push(root); return new ApiAgentSessionStore(root); }
function session(count = 9): ApiAgentSession { return { version: 1, partnerId: 'p', conversationId: 'c', provider: 'fixture', bootstrapSystemPrompt: '原启动人设', bootstrapVersion: 1, updatedAt: '', turns: Array.from({ length: count }, (_, i) => ({ clientMessageId: `u${i}`, userContent: `目标${i}`, completedAt: 'now', messages: [{ role: 'assistant', content: `证据${i} ${'背景'.repeat(300)}`, reasoningContent: '不应发送的推理' }] })) }; }
function provider(handler?: (request: ApiProviderRequest) => void): ApiProviderAdapter { return { provider: 'fixture', capabilities: { streamingText: true, reasoning: false, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } }, async *stream(input) { handler?.(input); yield { type: 'text.delta', text: '已完成旧步骤，继续目标，保留证据。' }; yield { type: 'finish', reason: 'stop' }; } }; }

describe('session maintenance ownership and concurrency', () => {
  it('deduplicates commands, rejects busy/conflicting requests, and releases the writer on failure', async () => {
    const leases = new WriterLeaseCoordinator(); let finish!: () => void;
    const execute = vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { status: 'compacted' as const, message: 'ok' }; });
    const service = new SessionCompactionService(leases, execute);
    const running = service.compact(request); expect(service.compact(request)).toBe(running);
    await expect(service.compact({ ...request, sessionId: 'wrong' })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(service.compact({ ...request, commandId: 'new' })).rejects.toThrow('BUSY');
    await Promise.resolve(); finish(); await running; expect(execute).toHaveBeenCalledOnce();
    expect(leases.ownerFor(conversationWriterScope(request))).toBeUndefined();
    const lease = leases.tryAcquire(conversationWriterScope(request), 'normal-run')!;
    await expect(service.compact({ ...request, commandId: 'third' })).rejects.toThrow('BUSY'); lease.release();
    const failing = new SessionCompactionService(leases, async () => { throw new Error('offline'); });
    await expect(failing.compact(request)).rejects.toThrow('offline'); expect(leases.ownerFor(conversationWriterScope(request))).toBeUndefined();
  });
  it('blocks normal reply starts while maintenance owns the conversation', async () => {
    const leases = new WriterLeaseCoordinator(); const lease = leases.tryAcquire(conversationWriterScope(request), 'compact:request')!;
    const coordinator = new RunCoordinator(new AdapterHost(), { deliver: vi.fn(), emit: vi.fn(), observe: vi.fn() }, leases);
    const send = vi.fn();
    await expect(coordinator.start({ sendMessage: send } as unknown as PartnerAdapter, { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'send', partnerId: 'p', conversationId: 'c', connectionSource: 'api_partner', clientMessageId: 'u', content: { type: 'text', text: 'next' } })).rejects.toThrow('COMPACT_CONVERSATION_BUSY');
    expect(send).not.toHaveBeenCalled(); lease.release();
  });
  it('aborts timed-out maintenance and rejects invalid or expanded routes', async () => {
    const leases = new WriterLeaseCoordinator();
    const service = new SessionCompactionService(leases, async (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), 5);
    await expect(service.compact(request)).rejects.toThrow('aborted'); expect(leases.ownerFor(conversationWriterScope(request))).toBeUndefined();
    for (const value of [{ ...request, source: 'existing_thread' }, { ...request, sessionId: '' }, { ...request, route: { scope: 'group' } }]) expect(() => assertSessionCompactRequest(value)).toThrow();
  });
});

describe('API context compaction', () => {
  it('retains six ordinary complete turns plus intervening reload confirmations without changing applied profiles', async () => {
    const saved = await store(), value = session();
    value.bootstrapSystemPrompt = '已应用 USER_NEW_B / PERSONA_NEW_B';
    value.turns.splice(5, 0, { clientMessageId: 'profile-reload:command', userContent: '明确重读完整人设', messages: [{ role: 'assistant', content: '确认', reasoningContent: '' }], completedAt: 'now' });
    await saved.remember(value);
    await compactApiSession(saved, 'p', 'c', provider(), new AbortController().signal);
    const compressed = (await saved.load('p', 'c'))!;
    expect(compressed.turns.filter((turn) => !turn.clientMessageId.startsWith('profile-reload:')).map((turn) => turn.clientMessageId)).toEqual(['u3', 'u4', 'u5', 'u6', 'u7', 'u8']);
    expect(compressed.turns.some((turn) => turn.clientMessageId === 'profile-reload:command')).toBe(true);
    expect(compressed.bootstrapSystemPrompt).toBe(value.bootstrapSystemPrompt);
  });
  it('persists a bounded summary and whole recent turns, keeps bootstrap, and uses it after reload without legacy replay', async () => {
    const saved = await store(); const initial = session(); initial.turns[3].messages = [{ role: 'assistant', content: '', reasoningContent: '', toolCalls: [{ id: 'call', name: 'read_file', arguments: '{}' }] }, { role: 'tool', toolCallId: 'call', content: 'result' }, { role: 'assistant', content: '已核对', reasoningContent: '' }];
    await saved.remember(initial); const recent = (await saved.load('p', 'c'))!.turns.slice(-6);
    const inputs: ApiProviderRequest[] = []; const model = provider((input) => inputs.push(input));
    expect((await compactApiSession(saved, 'p', 'c', model, new AbortController().signal)).status).toBe('compacted');
    const compressed = (await saved.load('p', 'c'))!;
    expect(compressed.turns).toEqual(recent); expect(compressed.bootstrapSystemPrompt).toBe('原启动人设'); expect(compressed.compaction?.throughClientMessageId).toBe('u2');
    expect(inputs[0].tools).toEqual([]); expect(JSON.stringify(inputs)).not.toContain('不应发送的推理');
    const runtime = new ApiAgentRuntime({ provider: model, sessionStore: saved });
    for await (const event of runtime.sendMessage({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'send', partnerId: 'p', conversationId: 'c', connectionSource: 'api_partner', clientMessageId: 'new', sessionId: 's', content: { type: 'text', text: '继续' }, execution: { permissionMode: 'read_only', planMode: 'default' }, apiContext: { history: [{ role: 'user', content: '不应回灌的旧历史' }], apiSessionHistoryEnabled: true } })) expect(event.type).toBeTruthy();
    expect(inputs.at(-1)!.messages).toContainEqual({ role: 'system', content: '原启动人设' });
    expect(JSON.stringify(inputs.at(-1)!.messages)).toContain('此前对话的压缩摘要'); expect(JSON.stringify(inputs.at(-1)!.messages)).not.toContain('不应回灌');
    expect(inputs.at(-1)!.messages.some((message) => message.role === 'tool' && message.toolCallId === 'call')).toBe(true);
    const secondInputs: ApiProviderRequest[] = []; await compactApiSession(saved, 'p', 'c', provider((input) => secondInputs.push(input)), new AbortController().signal);
    expect(JSON.stringify(secondInputs)).toContain('previousSummary');
  });
  it('does not change history for short sessions, model failures, empty output or tool requests', async () => {
    const saved = await store(); await saved.remember(session(6));
    const noCalls = vi.fn(); expect((await compactApiSession(saved, 'p', 'c', provider(noCalls), new AbortController().signal)).status).toBe('unchanged'); expect(noCalls).not.toHaveBeenCalled();
    await saved.remember(session()); const before = await saved.load('p', 'c');
    for (const mode of ['failure', 'empty', 'tool', 'length']) {
      const model = provider(); model.stream = async function* () { if (mode === 'failure') throw new Error('offline'); if (mode === 'tool') yield { type: 'tool.delta', index: 0, name: 'run_command' }; yield { type: 'finish', reason: mode === 'length' ? 'length' : 'stop' }; };
      await expect(compactApiSession(saved, 'p', 'c', model, new AbortController().signal)).rejects.toThrow(); expect(await saved.load('p', 'c')).toEqual(before);
    }
  });
  it('refuses a stale/deleted session commit and rejects regeneration before the saved boundary', async () => {
    const saved = await store(); await saved.remember(session()); const original = (await saved.load('p', 'c'))!;
    await saved.delete('p', 'c'); await expect(saved.replaceIfUnchanged(original, original)).rejects.toThrow('SESSION_CHANGED');
    await saved.remember({ ...session(2), compaction: { summary: '旧摘要', throughClientMessageId: 'old', createdAt: 'now' } });
    const input = vi.fn(); const runtime = new ApiAgentRuntime({ provider: provider(input), sessionStore: saved });
    const events = []; for await (const event of runtime.sendMessage({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'r', partnerId: 'p', conversationId: 'c', connectionSource: 'api_partner', clientMessageId: 'new', sessionId: 's', content: { type: 'text', text: '再生成' }, apiContext: { history: [], apiSessionHistoryEnabled: true, replaceTurnClientMessageId: 'before-summary' } })) events.push(event);
    expect(input).not.toHaveBeenCalled(); expect(events.at(-1)?.type).toBe('run.failed'); expect((await saved.load('p', 'c'))!.compaction?.summary).toBe('旧摘要');
  });
  it('merges long history in bounded chunks and never sends thought records to the compactor', async () => {
    const saved = await store(); const value = session(); value.turns[0].messages[0] = { role: 'assistant', content: '长背景'.repeat(10000), reasoningContent: '不应发送的推理' }; value.compaction = { summary: '必须保留的旧摘要', throughClientMessageId: 'old', createdAt: 'now' };
    await saved.remember(value); const inputs: ApiProviderRequest[] = [];
    expect((await compactApiSession(saved, 'p', 'c', provider((input) => inputs.push(input)), new AbortController().signal)).status).toBe('compacted');
    expect(inputs.length).toBeGreaterThan(1); expect(JSON.stringify(inputs[0])).toContain('必须保留的旧摘要');
    expect(JSON.stringify(inputs[1])).toContain('已完成旧步骤'); expect(JSON.stringify(inputs)).not.toContain('不应发送的推理');
    expect((await saved.load('p', 'c'))!.turns.map((turn) => turn.clientMessageId)).toEqual(['u3', 'u4', 'u5', 'u6', 'u7', 'u8']);
  });
  it('preserves original context on cancellation even if a provider ignores its signal', async () => {
    const saved = await store(); await saved.remember(session()); const before = await saved.load('p', 'c'); const controller = new AbortController();
    const model = provider(); model.stream = async function* () { await new Promise(() => undefined); yield { type: 'finish', reason: 'stop' }; };
    const running = compactApiSession(saved, 'p', 'c', model, controller.signal); void running.catch(() => undefined);
    await Promise.resolve(); controller.abort(new Error('cancelled')); await expect(running).rejects.toThrow('cancelled'); expect(await saved.load('p', 'c')).toEqual(before);
  });
  it('fails closed on a corrupt compaction boundary instead of falling back to visible history', async () => {
    const saved = await store(); await saved.remember({ ...session(), compaction: { summary: 'summary', throughClientMessageId: 'old', createdAt: 'now' } });
    const root = roots.at(-1)!; const file = path.join(root, (await readdir(root)).find((name) => name !== 'index.json')!);
    const raw = JSON.parse(await readFile(file, 'utf8')); raw.compaction.summary = ''; await writeFile(file, JSON.stringify(raw));
    await expect(saved.load('p', 'c')).rejects.toThrow('API_COMPACTION_RECORD_INVALID');
  });
});
