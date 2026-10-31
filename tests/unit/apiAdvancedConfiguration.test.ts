// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { apiModelSettingsSchema, apiRequestSettingsSchema } from '../../src/shared/apiConnections';
import { ChatCompletionsAdapter } from '../../src/main/adapters/ChatCompletionsAdapter';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import { DeepSeekProviderAdapter } from '../../src/main/adapters/DeepSeekProviderAdapter';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent } from '../../src/shared/agentProtocol';

describe('advanced API configuration', () => {
  it('keeps DeepSeek-specific thinking and token parameter behavior in non-streaming mode', async () => {
    const bodies: any[] = [];
    const adapter = new DeepSeekProviderAdapter({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'fixture-model', apiKey: 'fixture', thinkingMode: 'enabled', reasoningEffort: 'high', requestSettings: { stream: false }, modelSettings: { autoCompact: false, maxOutputTokens: 77 }, fetcher: async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })); } });
    for await (const event of adapter.stream({ messages: [], tools: [], signal: new AbortController().signal })) expect(event).toBeDefined();
    expect(bodies[0]).toMatchObject({ max_tokens: 77, thinking: { type: 'enabled' }, reasoning_effort: 'high', stream: false }); expect(bodies[0]).not.toHaveProperty('max_completion_tokens');
  });
  it('rejects managed body fields, conflicting headers and impossible budgets', () => {
    for (const key of ['messages', 'model', 'tools', 'input', 'system', 'authorization', 'temperature', 'thinking']) expect(apiModelSettingsSchema.safeParse({ extra: { [key]: 'bad' } }).success).toBe(false);
    for (const name of ['Authorization', 'Host', 'Cookie', 'Content-Length']) expect(apiRequestSettingsSchema.safeParse({ headers: [{ name, credentialRef: 'ref' }] }).success).toBe(false);
    expect(apiRequestSettingsSchema.safeParse({ auth: 'custom' }).success).toBe(false);
    expect(apiRequestSettingsSchema.safeParse({ headers: [{ name: 'X-Test', credentialRef: 'a' }, { name: 'x-test', credentialRef: 'b' }] }).success).toBe(false);
    expect(apiModelSettingsSchema.safeParse({ autoCompact: true }).success).toBe(false);
    expect(apiModelSettingsSchema.safeParse({ inputBudget: 100, contextWindow: 150, maxOutputTokens: 100 }).success).toBe(false);
    expect(apiModelSettingsSchema.parse({})).toEqual({ autoCompact: false });
  });
  it('sends only explicitly configured generation, auth and headers to the chosen path', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })));
    const adapter = new ChatCompletionsAdapter({ endpoint: 'https://fixture.invalid/v1', model: 'm', apiKey: 'fixture', fetcher, headers: { 'X-Tenant': 'private-fixture' }, requestSettings: { auth: 'x-api-key', path: '/custom/chat', stream: false }, modelSettings: { autoCompact: false, temperature: 0, topP: 0.8, maxOutputTokens: 90, extra: { enable_thinking: true } } });
    for await (const item of adapter.stream({ messages: [], tools: [], signal: new AbortController().signal })) expect(item).toBeDefined();
    expect(fetcher.mock.calls[0]).toEqual(['https://fixture.invalid/custom/chat', expect.objectContaining({ headers: { 'Content-Type': 'application/json', 'x-api-key': 'fixture', 'X-Tenant': 'private-fixture' } })]);
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ temperature: 0, top_p: 0.8, max_completion_tokens: 90, enable_thinking: true, stream: false });
    expect(body).not.toHaveProperty('reasoning_effort');
  });
  it('stops before a disabled tool can execute and stops oversized context before requesting a model', async () => {
    const requests: ApiProviderRequest[] = [];
    const provider: ApiProviderAdapter = { provider: 'fixture', capabilities: { streamingText: true, reasoning: false, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } }, async *stream(request) { requests.push(request); yield { type: 'tool.delta', index: 0, id: 'x', name: 'write_file', arguments: '{}' }; yield { type: 'finish', reason: 'tool_calls' }; } };
    const command = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send' as const, commandId: 'cmd', partnerId: 'p', conversationId: 'c', connectionSource: 'api_partner' as const, clientMessageId: 'm', content: { type: 'text' as const, text: 'hello' } };
    let events: PartnerEvent[] = []; for await (const event of new ApiAgentRuntime({ provider, toolsEnabled: false }).sendMessage(command)) events.push(event);
    expect(requests[0].tools).toEqual([]); expect(events).toContainEqual(expect.objectContaining({ type: 'run.failed', error: expect.objectContaining({ code: 'API_TOOLS_DISABLED' }) }));
    requests.length = 0; events = [];
    for await (const event of new ApiAgentRuntime({ provider, modelSettings: { autoCompact: true, inputBudget: 1 } }).sendMessage(command)) events.push(event);
    expect(requests).toHaveLength(0); expect(events).toContainEqual(expect.objectContaining({ type: 'run.failed', error: expect.objectContaining({ code: 'API_CONTEXT_OVER_BUDGET' }) }));
  });
});
