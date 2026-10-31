// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApiPartnerAdapter } from '../../src/main/adapters/ApiPartnerAdapter';
import { ApiAgentSessionStore } from '../../src/main/api/ApiAgentSessionStore';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { AGENT_PROTOCOL_VERSION, type ApiPartnerConnection } from '../../src/shared/agentProtocol';

const protocols = ['openai', 'responses', 'anthropic', 'gemini'] as const;
const sse = (values: unknown[]) => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
function reply(provider: ApiPartnerConnection['provider'], tool: boolean) {
  const call = { id: 'call', name: 'read_file', arguments: '{"path":"fixture.txt"}' };
  if (provider === 'openai') return sse([{ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: call.arguments } }] } : { content: 'public-answer' }, finish_reason: tool ? 'tool_calls' : 'stop' }] }]);
  if (provider === 'responses') return sse([{ type: 'response.completed', response: { status: 'completed', output: tool ? [{ type: 'reasoning', id: 'r', summary: [], encrypted_content: 'private-native-state' }, { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'public-answer' }] }] } }]);
  if (provider === 'anthropic') {
    const blocks = tool ? [{ type: 'thinking', thinking: 'public-summary', signature: 'private-native-state' }, { type: 'tool_use', id: call.id, name: call.name, input: { path: 'fixture.txt' } }] : [{ type: 'text', text: 'public-answer' }];
    return sse([...blocks.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]), { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }]);
  }
  return sse([{ candidates: [{ content: { role: 'model', parts: tool ? [{ functionCall: { id: call.id, name: call.name, args: { path: 'fixture.txt' } }, thoughtSignature: 'private-native-state' }] : [{ text: 'public-answer' }] }, finishReason: 'STOP' }] }]);
}
async function cleanup(directory: string) {
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('UNSAFE_CLEANUP');
  await rm(directory, { recursive: true, force: true });
}
describe('all protocol and model switching pairs', () => {
  for (const from of protocols) for (const to of protocols) it(`${from} → ${to}: portable history survives restart, completed tools never rerun`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-api-switch-'));
    try {
      await writeFile(path.join(directory, 'fixture.txt'), 'fixture-content');
      const store = new ApiAgentSessionStore(path.join(directory, 'sessions'));
      const tools = new ApiAgentTools(directory, []), prepared = vi.spyOn(tools, 'prepare');
      let requests = 0;
      const options = { endpoint: 'https://fixture.invalid/v1', model: 'model-a', apiKey: 'fixture', toolsEnabled: true, tools, sessionStore: store, modelSettings: { autoCompact: false, maxOutputTokens: 512 } };
      const command = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send' as const, commandId: 'cmd', partnerId: 'p', conversationId: 'c', connectionSource: 'api_partner' as const, clientMessageId: 'first', content: { type: 'text' as const, text: 'known-target: read fixture file' } };
      const first = new ApiPartnerAdapter({ ...options, provider: from, bindingKey: 'old', fetcher: vi.fn(async () => reply(from, ++requests === 1)) });
      const events = []; for await (const event of first.sendMessage(command)) events.push(event);
      expect(events.some(e => e.type === 'run.completed')).toBe(true); expect(prepared).toHaveBeenCalledTimes(1);
      let body = '';
      const second = new ApiPartnerAdapter({ ...options, model: 'model-b', provider: to, bindingKey: 'new', toolsEnabled: false, sessionStore: new ApiAgentSessionStore(path.join(directory, 'sessions')), fetcher: vi.fn(async (_url: unknown, init?: RequestInit) => { body = init!.body as string; return reply(to, false); }) });
      for await (const event of second.sendMessage({ ...command, clientMessageId: 'second', content: { type: 'text', text: 'Continue from known target' } })) events.push(event);
      expect(body).toContain('known-target'); expect(body).toContain('fixture-content'); expect(body).toContain('public-answer');
      expect(body).not.toContain('private-native-state'); expect(prepared).toHaveBeenCalledTimes(1);
      expect((await store.load('p', 'c'))?.turns).toHaveLength(2);
      expect(events.at(-1)?.type).toBe('run.completed');
    } finally { await cleanup(directory); }
  });
});
