export type DeepSeekStreamEvent =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { type: 'finish'; reason: string }
  | { type: 'done' };

export class DeepSeekStreamParser {
  private buffer = '';
  private done = false;

  push(chunk: string) {
    if (this.done || !chunk) return [];
    this.buffer += chunk;
    const events: DeepSeekStreamEvent[] = [];
    for (;;) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) break;
      const separator = this.buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + separator.length);
      events.push(...this.parseBlock(block));
    }
    return events;
  }

  finish() {
    const trailing = this.buffer.trim();
    this.buffer = '';
    if (trailing) return this.parseBlock(trailing);
    return [];
  }

  get completed() {
    return this.done;
  }

  private parseBlock(block: string): DeepSeekStreamEvent[] {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return [];
    if (data === '[DONE]') {
      this.done = true;
      return [{ type: 'done' }];
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error('DEEPSEEK_MALFORMED_SSE');
    }
    if (!isRecord(value) || !Array.isArray(value.choices)) throw new Error('DEEPSEEK_MALFORMED_SSE');
    const events: DeepSeekStreamEvent[] = [];
    if (isRecord(value.usage)) {
      events.push({
        type: 'usage',
        promptTokens: numberOrUndefined(value.usage.prompt_tokens),
        completionTokens: numberOrUndefined(value.usage.completion_tokens),
        totalTokens: numberOrUndefined(value.usage.total_tokens),
      });
    }
    for (const choice of value.choices) {
      if (!isRecord(choice)) throw new Error('DEEPSEEK_MALFORMED_SSE');
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) events.push({ type: 'reasoning', text: delta.reasoning_content });
      if (typeof delta.content === 'string' && delta.content) events.push({ type: 'content', text: delta.content });
      if (Array.isArray(delta.tool_calls)) {
        for (const item of delta.tool_calls) {
          if (!isRecord(item) || !Number.isSafeInteger(item.index) || (item.index as number) < 0) throw new Error('DEEPSEEK_MALFORMED_SSE');
          const fn = isRecord(item.function) ? item.function : {};
          events.push({
            type: 'tool_call_delta',
            index: item.index as number,
            ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}),
            ...(typeof fn.name === 'string' && fn.name ? { name: fn.name } : {}),
            ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}),
          });
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) events.push({ type: 'finish', reason: choice.finish_reason });
    }
    return events;
  }
}

function numberOrUndefined(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
