// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { CodexCliAdapter } from '../../src/main/adapters/CodexCliAdapter';
import { ClaudeCodeAdapter } from '../../src/main/adapters/ClaudeCodeAdapter';
import type { CodexAppServerTransport, CodexRpcMessage } from '../../src/main/adapters/codexAppServerProtocol';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }));
class Transport implements CodexAppServerTransport {
  connected = true;
  listeners = new Set<(event: CodexRpcMessage) => void>();
  closes = new Set<(error: Error) => void>();
  requests: string[] = [];
  async start() {}
  async request<T>(method: string) { this.requests.push(method); return (method === 'thread/resume' ? { thread: { id: 's' }, model: 'fixture' } : {}) as T; }
  respond() {}
  onMessage(listener: (event: CodexRpcMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onClose(listener: (error: Error) => void) { this.closes.add(listener); return () => this.closes.delete(listener); }
  async close() { this.connected = false; for (const listener of this.closes) listener(new Error('closed')); }
  emit(method: string, fields: Record<string, unknown> = {}) { for (const listener of this.listeners) listener({ method, params: { threadId: 's', turnId: 'compact', ...fields } }); }
}
describe('native session compaction', () => {
  it('waits beyond the Codex RPC receipt for the matching compaction and terminal events', async () => {
    const transport = new Transport(); const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    let settled = false; const running = adapter.compactSession('s', new AbortController().signal).then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(transport.requests).toContain('thread/compact/start'));
    expect(settled).toBe(false);
    transport.emit('turn/started', { turn: { id: 'compact' } });
    transport.emit('item/completed', { threadId: 'wrong', item: { type: 'contextCompaction' } });
    transport.emit('item/completed', { turnId: 'other', item: { type: 'contextCompaction' } });
    transport.emit('item/completed', { item: { type: 'contextCompaction' } });
    expect(settled).toBe(false);
    transport.emit('turn/completed', { turn: { id: 'compact', status: 'completed' } });
    expect((await running).status).toBe('compacted'); expect(transport.requests).not.toContain('turn/start'); await adapter.dispose();
  });
  it.each(['no-boundary', 'failed', 'abort'])('handles Codex %s without reporting a compression success', async (kind) => {
    const transport = new Transport(); const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport); const controller = new AbortController();
    const running = adapter.compactSession('s', controller.signal); void running.catch(() => undefined);
    await vi.waitFor(() => expect(transport.requests).toContain('thread/compact/start'));
    transport.emit('turn/started', { turn: { id: 'compact' } });
    if (kind === 'abort') controller.abort();
    else transport.emit('turn/completed', { turn: { id: 'compact', status: kind === 'failed' ? 'failed' : 'completed' } });
    if (kind === 'no-boundary') expect((await running).status).toBe('unchanged'); else await expect(running).rejects.toThrow(); await adapter.dispose();
  });
  it.each(['boundary', 'short', 'failed', 'wrong-session'])('runs the Claude native command with tools disabled and handles %s', async (kind) => {
    let options!: Options;
    sdk.query.mockImplementation((input: { prompt: string; options: Options }) => {
      expect(input.prompt).toBe('/compact'); options = input.options;
      const stream = (async function* () {
        if (kind === 'boundary') yield { type: 'system', subtype: 'compact_boundary', session_id: 's' };
        if (kind === 'wrong-session') yield { type: 'system', subtype: 'init', session_id: 'wrong' };
        yield { type: 'result', subtype: kind === 'failed' ? 'error_during_execution' : 'success', session_id: 's' };
      })(); return Object.assign(stream, { close: vi.fn() });
    });
    const adapter = new ClaudeCodeAdapter('claude.exe', 'K:\\qa');
    const running = adapter.compactSession('s', new AbortController().signal, { version: 1, content: '原启动资料', createdAt: '', timeZone: '' });
    if (kind === 'failed' || kind === 'wrong-session') await expect(running).rejects.toThrow();
    else expect((await running).status).toBe(kind === 'boundary' ? 'compacted' : 'unchanged');
    expect(options.resume).toBe('s'); expect(options.tools).toEqual([]); expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.settings).toEqual({ disableAllHooks: true }); expect(options.strictMcpConfig).toBe(true);
    expect(options.systemPrompt).toMatchObject({ append: '原启动资料' }); expect(options.permissionMode).toBeUndefined();
    expect(await options.canUseTool!('Write', {}, { signal: new AbortController().signal, toolUseID: 'x', requestId: 'x' })).toMatchObject({ behavior: 'deny' });
    await adapter.dispose();
  });
});
