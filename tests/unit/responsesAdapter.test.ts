// @vitest-environment node
import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ResponsesAdapter, responsesInput } from '../../src/main/adapters/ResponsesAdapter';
import { ApiPartnerAdapter } from '../../src/main/adapters/ApiPartnerAdapter';
import { ApiAgentSessionStore, bindApiSession } from '../../src/main/api/ApiAgentSessionStore';
import { AGENT_PROTOCOL_VERSION } from '../../src/shared/agentProtocol';

const reasoning = { type: 'reasoning', id: 'r', summary: [], encrypted_content: 'opaque-fixture' };
const call = { type: 'function_call', id: 'fc', call_id: 'call', name: 'fixture_tool', arguments: '{}' };
const message = { type: 'message', id: 'msg', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'OK', annotations: [] }], status: 'completed' };
const sse = (events: unknown[]) => new Response(events.map(data => `data: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
async function cleanup(directory: string) {
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('UNSAFE_CLEANUP');
  await rm(directory, { recursive: true, force: true });
}
describe('Responses protocol', () => {
  it('preserves complete output and opaque reasoning through tool rounds and restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-responses-'));
    try {
      const bodies: any[] = []; const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(init!.body as string));
        const output = bodies.length === 1 ? [reasoning, call] : [message];
        return sse([{ type: 'response.output_item.done', output_index: 0, item: output[0] }, { type: 'response.completed', response: { status: 'completed', output } }]);
      });
      const store = new ApiAgentSessionStore(directory);
      const options = { provider: 'responses' as const, endpoint: 'https://fixture.invalid/v1', model: 'm', apiKey: 'fixture', bindingKey: 'b', fetcher, sessionStore: store };
      const command = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send' as const, commandId: 'cmd', partnerId: 'p', conversationId: 'c', connectionSource: 'api_partner' as const, clientMessageId: 'one', content: { type: 'text' as const, text: 'hello' } };
      const events = []; for await (const event of new ApiPartnerAdapter(options).sendMessage(command)) events.push(event);
      expect(events.some(e => e.type === 'run.completed')).toBe(true);
      expect(bodies[0]).toMatchObject({ store: false, model: 'm' }); expect(bodies[0]).not.toHaveProperty('previous_response_id');
      expect(bodies[1].input).toContainEqual(reasoning); expect(bodies[1].input).toContainEqual(call);
      expect(bodies[1].input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call' }));
      const saved = (await store.load('p', 'c'))!;
      expect(saved.turns[0].messages[0]).toMatchObject({ native: { binding: 'b', items: [reasoning, call] } });
      const restarted = new ApiAgentSessionStore(directory);
      for await (const event of new ApiPartnerAdapter({ ...options, sessionStore: restarted }).sendMessage({ ...command, clientMessageId: 'two' })) expect(event).toBeDefined();
      expect(bodies[2].input).toContainEqual(message);
      const portable = bindApiSession(saved, 'openai', 'other');
      expect(JSON.stringify(portable)).not.toContain('opaque-fixture'); expect(JSON.stringify(portable)).toContain('OK');
      expect(JSON.stringify(events)).not.toContain('opaque-fixture');
    } finally {
      await cleanup(directory);
    }
  });
  it('emits streaming deltas once, retains terminal state, and rejects incomplete streams', async () => {
    const adapter = new ResponsesAdapter({ endpoint: 'https://fixture.invalid/v1', model: 'm', apiKey: 'fixture', fetcher: vi.fn(async () => sse([{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed', output: [message] } }])) });
    const events = []; for await (const event of adapter.stream({ messages: [], tools: [], signal: new AbortController().signal })) events.push(event);
    expect(events.filter(e => e.type === 'text.delta')).toEqual([{ type: 'text.delta', text: 'OK' }]);
    expect(events).toContainEqual({ type: 'native.state', items: [message] });
    const broken = new ResponsesAdapter({ endpoint: 'https://fixture.invalid/v1', model: 'm', apiKey: 'fixture', fetcher: vi.fn(async () => sse([{ type: 'response.output_text.delta', delta: 'partial' }])) });
    await expect((async () => { for await (const event of broken.stream({ messages: [], tools: [], signal: new AbortController().signal })) expect(event).toBeDefined(); })()).rejects.toThrow('INTERRUPTED');
  });
  it('maps images and portable tool facts and supports non-streaming', async () => {
    expect(responsesInput([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'fixture' }] }, { role: 'tool', toolCallId: 'call', content: 'done' }])).toEqual([{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,fixture' }] }, { type: 'function_call_output', call_id: 'call', output: 'done' }]);
    const adapter = new ResponsesAdapter({ endpoint: 'https://fixture.invalid/v1', model: 'm', apiKey: 'fixture', requestSettings: { stream: false }, fetcher: vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [message] }))) });
    const events = []; for await (const event of adapter.stream({ messages: [], tools: [], signal: new AbortController().signal })) events.push(event);
    expect(events).toContainEqual({ type: 'text.delta', text: 'OK' });
  });
});
