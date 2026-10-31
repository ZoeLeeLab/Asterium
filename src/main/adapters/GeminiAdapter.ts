import { randomUUID } from 'node:crypto';
import type { ApiProviderAdapter, ApiProviderMessage, ApiProviderRequest, ApiProviderStreamEvent } from '../api/ApiProviderAdapter';
import type { ApiProviderAdapterOptions } from '../api/ApiProviderRegistry';
import { apiFetch, apiSse } from '../api/ApiHttpTransport';
import { apiGeneration, apiHeaders } from '../api/ApiRequestConfiguration';
import { geminiEndpoint } from '../../shared/apiEndpoints';
import { GENERIC_API_ATTACHMENTS } from './ChatCompletionsAdapter';
import { abortable } from '../api/abortable';

export class GeminiAdapter implements ApiProviderAdapter {
  readonly provider = 'gemini';
  readonly capabilities = { streamingText: true, reasoning: true, toolCalls: true, attachments: GENERIC_API_ATTACHMENTS };
  constructor(private readonly options: ApiProviderAdapterOptions) {}
  async *stream(request: ApiProviderRequest): AsyncIterable<ApiProviderStreamEvent> {
    const streaming = this.options.requestSettings?.stream !== false;
    const generation = apiGeneration(this.options, 'gemini');
    const response = await apiFetch(geminiEndpoint(this.options.endpoint, this.options.model, streaming, this.options.requestSettings?.path), {
      method: 'POST', signal: request.signal, headers: apiHeaders(this.options, 'gemini'),
      body: JSON.stringify({ ...geminiInput(request.messages, this.options.bindingKey), ...(Object.keys(generation).length ? { generationConfig: generation } : {}),
        ...(request.tools.length ? { tools: [{ functionDeclarations: request.tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }] } : {}),
      }),
    }, this.options.fetcher, this.options.requestSettings?.headerTimeoutMs);
    const parts: any[] = []; let reason = '';
    const chunks: AsyncIterable<any> = streaming ? apiSse(response, request.signal) : (async function* () { yield await abortable(response.json(), request.signal); })();
    for await (const data of chunks) {
      if (data.error || data.promptFeedback?.blockReason) throw new Error('GEMINI_RESPONSE_REJECTED');
      const candidate = data.candidates?.find((item: any) => item.index === 0) ?? data.candidates?.[0];
      if (candidate?.content?.role && candidate.content.role !== 'model') throw new Error('GEMINI_CONTENT_INVALID');
      for (const part of candidate?.content?.parts ?? []) {
        if (!part || typeof part !== 'object') throw new Error('GEMINI_CONTENT_INVALID');
        // Keep signature-bearing parts separate and in original order, including empty text parts.
        parts.push(structuredClone(part));
        if (typeof part.text === 'string' && part.text) yield { type: part.thought ? 'reasoning.delta' : 'text.delta', text: part.text };
      }
      if (candidate?.finishReason) reason = candidate.finishReason;
      if (data.usageMetadata) yield { type: 'usage', promptTokens: data.usageMetadata.promptTokenCount, completionTokens: data.usageMetadata.candidatesTokenCount, totalTokens: data.usageMetadata.totalTokenCount };
    }
    if (!reason) throw new Error('API_STREAM_INTERRUPTED');
    let index = 0;
    for (const part of parts) if (part.functionCall) {
      const call = part.functionCall;
      if (typeof call.name !== 'string' || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) throw new Error('GEMINI_FUNCTION_INVALID');
      yield { type: 'tool.delta', index: index++, id: typeof call.id === 'string' ? call.id : `gemini-${randomUUID()}`, name: call.name, arguments: JSON.stringify(call.args) };
    }
    yield { type: 'native.state', items: [{ role: 'model', parts }] };
    yield { type: 'finish', reason: reason === 'STOP' && index ? 'tool_calls' : reason };
  }
}
export function geminiInput(input: ApiProviderMessage[], binding?: string) {
  const system: { text: string }[] = [], contents: { role: 'user' | 'model'; parts: any[] }[] = [];
  const calls = new Map<string, { name: string; id?: string }>();
  const append = (role: 'user' | 'model', parts: any[]) => {
    if (!parts.length) return; const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts); else contents.push({ role, parts: [...parts] });
  };
  for (const message of input) {
    if (message.role === 'system') { system.push({ text: message.content }); continue; }
    if (message.role === 'assistant') {
      calls.clear();
      if (binding && message.native?.binding === binding) {
        const native = message.native.items[0] as any;
        if (message.native.items.length !== 1 || native?.role !== 'model' || !Array.isArray(native.parts)) throw new Error('GEMINI_STATE_INVALID');
        const nativeCalls = native.parts.filter((part: any) => part.functionCall).map((part: any) => part.functionCall);
        if (nativeCalls.length !== (message.toolCalls?.length ?? 0)) throw new Error('GEMINI_STATE_INVALID');
        nativeCalls.forEach((call: any, index: number) => calls.set(message.toolCalls![index].id, { name: call.name, ...(call.id ? { id: call.id } : {}) }));
        append('model', native.parts);
      } else {
        append('model', [...(message.content ? [{ text: message.content }] : []), ...(message.toolCalls?.length ? [{ text: `[已完成的历史工具调用，仅作背景，不重新执行]\n${JSON.stringify(message.toolCalls)}` }] : [])]);
      }
      continue;
    }
    if (message.role === 'tool') {
      const call = calls.get(message.toolCallId);
      if (!call) { append('user', [{ text: `[已完成的历史工具结果，不授权新操作]\n${message.content}` }]); continue; }
      let parsed: unknown; try { parsed = JSON.parse(message.content); } catch { parsed = message.content; }
      append('user', [{ functionResponse: { ...call, response: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { output: parsed } } }]); continue;
    }
    append('user', typeof message.content === 'string' ? [{ text: message.content }] : message.content.map(part => part.type === 'text' ? { text: part.text } : { inlineData: { mimeType: part.mediaType, data: part.data } }));
  }
  return { ...(system.length ? { systemInstruction: { parts: system } } : {}), contents };
}
