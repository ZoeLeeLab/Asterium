// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { CodexCliAdapter } from '../../src/main/adapters/CodexCliAdapter';
import { ClaudeCodeAdapter } from '../../src/main/adapters/ClaudeCodeAdapter';
import type { CodexAppServerTransport, CodexRpcMessage } from '../../src/main/adapters/codexAppServerProtocol';
const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }));
const bootstrap = { version: 1 as const, content: '新版本完整资料', developerContent: '带资料边界的新版本', createdAt: '', timeZone: '' };

it('bounds Codex compensation even when starting the transport hangs', async () => {
  const transport = new Transport(), controller = new AbortController();
  vi.spyOn(transport, 'start').mockImplementation(() => new Promise(() => undefined));
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
  try {
    const pending = adapter.restoreProfileSnapshot('s', bootstrap); void pending.catch(() => undefined);
    controller.abort(new Error('restore-timeout'));
    await expect(pending).rejects.toThrow('restore-timeout');
    expect(transport.connected).toBe(false);
  } finally { timeout.mockRestore(); }
});
class Transport implements CodexAppServerTransport {
  connected = true;
  listeners = new Set<(event: CodexRpcMessage) => void>(); closes = new Set<(error: Error) => void>();
  requests: Array<{ method: string; params: unknown }> = [];
  async start() {}
  async request<T>(method: string, params: unknown) { this.requests.push({ method, params }); return (method === 'turn/start' ? { turn: { id: 'r' } } : { thread: { id: 's' } }) as T; }
  respond() {}
  onMessage(listener: (event: CodexRpcMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onClose(listener: (error: Error) => void) { this.closes.add(listener); return () => this.closes.delete(listener); }
  async close() { this.connected = false; for (const listener of this.closes) listener(new Error('closed')); }
  emit(method: string, fields: Record<string, unknown>) { for (const listener of this.listeners) listener({ method, params: { threadId: 's', turnId: 'r', ...fields } }); }
}
it.each(['success', 'tool', 'abort'])('Codex confirms only a matching completed turn with environment disabled (%s)', async (kind) => {
  const transport = new Transport(), adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport), controller = new AbortController();
  const promise = adapter.reloadProfiles('s', '仅确认', bootstrap, controller.signal); void promise.catch(() => undefined);
  await vi.waitFor(() => expect(transport.requests.some((r) => r.method === 'turn/start')).toBe(true));
  expect(transport.requests.find((r) => r.method === 'thread/resume')?.params).toMatchObject({ threadId: 's', developerInstructions: bootstrap.developerContent });
  expect(transport.requests.find((r) => r.method === 'turn/start')?.params).toMatchObject({ environments: [], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  transport.emit('turn/started', { turn: { id: 'r' } });
  if (kind === 'abort') controller.abort();
  else if (kind === 'tool') transport.emit('item/started', { item: { type: 'dynamicToolCall' } });
  else { transport.emit('item/agentMessage/delta', { delta: '已重读' }); transport.emit('turn/completed', { turn: { id: 'r', status: 'completed' } }); }
  if (kind === 'success') expect(await promise).toBe('已重读'); else await expect(promise).rejects.toThrow();
  await adapter.dispose();
});
it.each(['success', 'tool', 'failed'])('Claude resumes the same session using a tool-free confirmation (%s)', async (kind) => {
  let options!: Options;
  sdk.query.mockImplementation((input: { options: Options }) => {
    options = input.options;
    const stream = (async function* () {
      yield { type: 'assistant', session_id: 's', message: { content: kind === 'tool' ? [{ type: 'tool_use', name: 'Write' }] : [{ type: 'text', text: '已重读' }] } };
      yield { type: 'result', subtype: kind === 'failed' ? 'error_during_execution' : 'success', session_id: 's' };
    })(); return Object.assign(stream, { close: vi.fn() });
  });
  const adapter = new ClaudeCodeAdapter('claude.exe', 'K:\\qa');
  const promise = adapter.reloadProfiles('s', '仅确认', bootstrap, new AbortController().signal);
  if (kind === 'success') expect(await promise).toBe('已重读'); else await expect(promise).rejects.toThrow();
  expect(options.resume).toBe('s'); expect(options.tools).toEqual([]); expect(options.settings).toEqual({ disableAllHooks: true }); expect(options.systemPrompt).toMatchObject({ append: bootstrap.content });
});
