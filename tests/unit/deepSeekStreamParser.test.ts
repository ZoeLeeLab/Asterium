import { describe, expect, it } from 'vitest';
import { DeepSeekStreamParser } from '../../src/main/adapters/deepSeekStreamParser';

describe('DeepSeekStreamParser', () => {
  it('parses split CRLF chunks, content, finish reason, and DONE', () => {
    const parser = new DeepSeekStreamParser();
    const events = [
      ...parser.push('data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}\r\n'),
      ...parser.push('\r\ndata: {"choices":[{"delta":{"reasoning_content":"hidden"},"finish_reason":"stop"}]}\n\n'),
      ...parser.push('data: [DONE]\n\n'),
    ];
    expect(events).toEqual([
      { type: 'content', text: '你' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'finish', reason: 'stop' },
      { type: 'done' },
    ]);
    expect(parser.completed).toBe(true);
  });

  it('rejects malformed JSON SSE data', () => {
    const parser = new DeepSeekStreamParser();
    expect(() => parser.push('data: {oops}\n\n')).toThrow('DEEPSEEK_MALFORMED_SSE');
  });
});
