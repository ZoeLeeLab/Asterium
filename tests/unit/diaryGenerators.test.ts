import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { codexDiaryArgs, generateApiDiary, generateClaudeDiary, generateCodexDiary, generateExistingDiary } from '../../src/main/diary/DiaryGenerators';
import { DeepSeekProviderAdapter } from '../../src/main/adapters/DeepSeekProviderAdapter';
import type { ApiProviderAdapter } from '../../src/main/api/ApiProviderAdapter';

describe('isolated one-shot diary runtimes', () => {
  it('uses exactly one API request without any tools, history, or follow-up calls', async () => {
    let count = 0;
    const adapter: ApiProviderAdapter = { provider: 'fake', capabilities: new DeepSeekProviderAdapter({ endpoint: '', model: '', apiKey: '' }).capabilities,
      async *stream(input) { count++; expect(input.tools).toEqual([]); expect(input.messages).toHaveLength(2); expect(input.messages[1]).toEqual({ role: 'user', content: 'selected today only' }); yield { type: 'text.delta', text: '我今天读书。' }; yield { type: 'finish', reason: 'stop' }; } };
    expect(await generateApiDiary(adapter, 'selected today only', 'persona', new AbortController().signal)).toBe('我今天读书。'); expect(count).toBe(1);
  });
  it('blocks API tool requests instead of executing or continuing them', async () => {
    let count = 0;
    const adapter: ApiProviderAdapter = { provider: 'fake', capabilities: new DeepSeekProviderAdapter({ endpoint: '', model: '', apiKey: '' }).capabilities,
      async *stream() { count++; yield { type: 'tool.delta', index: 0, name: 'hold_memory', arguments: '{}' }; } };
    await expect(generateApiDiary(adapter, 'today', '', new AbortController().signal)).rejects.toThrow('TOOL_NOT_ALLOWED'); expect(count).toBe(1);
  });
  it('disables Claude tools/MCP/settings discovery and session persistence without resuming chat', async () => {
    const stream = Object.assign((async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: '我今天读书。' }; })(), { close: vi.fn() });
    const query = vi.fn((input: unknown) => { void input; return stream; });
    expect(await generateClaudeDiary({ executablePath: 'claude.exe', cwd: 'isolated', source: 'today', bootstrap: 'persona', signal: new AbortController().signal }, query as never)).toBe('我今天读书。');
    expect(query.mock.calls[0]).toEqual([expect.objectContaining({ options: expect.objectContaining({ tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false, maxTurns: 1 }) })]);
    expect(query.mock.calls[0][0]).not.toHaveProperty('options.resume'); expect(stream.close).toHaveBeenCalled();
  });
  it('runs a fresh ephemeral Codex exec, feeds only supplied stdin and captures only the final message', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    let prompt = ''; child.stdin.on('data', (chunk: Buffer) => { prompt += chunk.toString(); });
    const launch = vi.fn(() => child);
    const result = generateCodexDiary({ executablePath: 'codex.exe', cwd: 'isolated', source: 'today only', bootstrap: 'persona', signal: new AbortController().signal }, launch as never);
    child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '我今天读书。' } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`);
    child.emit('close', 0);
    expect(await result).toBe('我今天读书。'); expect(launch).toHaveBeenCalledTimes(1); expect(prompt).toContain('today only');
    expect(codexDiaryArgs()).toContain('--ephemeral'); expect(codexDiaryArgs()).not.toContain('resume'); expect(codexDiaryArgs()).toContain('mcp_servers={}');
    expect(codexDiaryArgs()).toEqual(expect.arrayContaining(['features.memories=false', 'features.hooks=false', 'features.image_generation=false', 'project_doc_max_bytes=0']));
    expect(codexDiaryArgs().some((argument) => argument.startsWith('model_providers.'))).toBe(false);
  });
  it('stops Codex at the first reported transport error without relaunching', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    const launch = vi.fn(() => child);
    const result = generateCodexDiary({ executablePath: 'codex.exe', cwd: 'isolated', source: 'today', bootstrap: '', signal: new AbortController().signal }, launch as never);
    child.stdout.write(`${JSON.stringify({ type: 'error', message: 'Reconnecting...' })}\n`);
    await expect(result).rejects.toThrow('DIARY_GENERATION_FAILED');
    expect(launch).toHaveBeenCalledTimes(1); expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it('checks the real upstream thread before sending and does not post when it changed', async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo) => String(url).endsWith('/api/auth') ? new Response('', { status: 200, headers: { 'set-cookie': 'cyberboss_web_session=test' } }) : Response.json({ threadId: 'different' }));
    await expect(generateExistingDiary({ serviceUrl: 'https://diary-test.example', credentialRef: 'ref', threadId: 'expected' }, 'fake', 'expected', 'generation', 'today', new AbortController().signal, fetcher as typeof fetch)).rejects.toThrow('THREAD_MISMATCH');
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes('/api/messages'))).toBe(true);
  });
  it('sends exactly once upstream, correlates the reply, and opens no reconnect stream', async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let clientMessageId = '';
    const emit = () => {
      if (!stream || !clientMessageId) return;
      const event = (id: string, role: string, text: string) => `event: chat\nid: ${id}\ndata: ${JSON.stringify({ role, text, clientMessageId, createdAt: new Date().toISOString(), status: '', media: [] })}\n\n`;
      stream.enqueue(new TextEncoder().encode(event('user', 'user', 'diary request') + event('reply', 'assistant', '我今天读书。'))); stream.close();
    };
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/auth') return new Response('', { headers: { 'set-cookie': 'cyberboss_web_session=test' } });
      if (pathname === '/api/session') return Response.json({ threadId: 'expected' });
      if (pathname === '/api/events') return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; emit(); } }), { headers: { 'content-type': 'text/event-stream' } });
      if (pathname === '/api/messages') { clientMessageId = JSON.parse(String(init?.body)).clientMessageId; emit(); return new Response('', { status: 202 }); }
      throw new Error('Unexpected request');
    });
    expect(await generateExistingDiary({ serviceUrl: 'https://diary-test.example', credentialRef: 'ref', threadId: 'expected' }, 'fake', 'expected', 'generation', 'today', new AbortController().signal, fetcher as typeof fetch)).toBe('我今天读书。');
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/api/messages'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/api/events'))).toHaveLength(1);
    expect(clientMessageId).toBe('asterium-diary-generation');
  });
});
