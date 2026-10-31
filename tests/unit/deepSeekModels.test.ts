import { describe, expect, it, vi } from 'vitest';
import { listDeepSeekModels, normalizeDeepSeekChatEndpoint } from '../../src/main/adapters/deepSeekModels';

describe('DeepSeek model discovery', () => {
  it('derives the models endpoint and returns validated unique model IDs', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'deepseek-v4-flash', owned_by: 'deepseek' },
      { id: 'deepseek-v4-flash', owned_by: 'deepseek' },
      { id: 'deepseek-v4-pro', owned_by: 'deepseek' },
      { nope: true },
    ] }), { status: 200 }));
    await expect(listDeepSeekModels('https://api.deepseek.com/v1/chat/completions', 'secret', fetcher)).resolves.toEqual([
      { id: 'deepseek-v4-flash', ownedBy: 'deepseek' }, { id: 'deepseek-v4-pro', ownedBy: 'deepseek' },
    ]);
    expect(fetcher).toHaveBeenCalledWith('https://api.deepseek.com/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer secret' } }));
  });

  it('rejects unofficial endpoints and maps authentication failures without response detail', async () => {
    expect(() => normalizeDeepSeekChatEndpoint('https://evil.example/chat/completions')).toThrow('INVALID_DEEPSEEK_ENDPOINT');
    await expect(listDeepSeekModels('https://api.deepseek.com/chat/completions', 'secret', vi.fn(async () => new Response('echo secret', { status: 401 })))).rejects.toThrow('DEEPSEEK_AUTH_FAILED');
  });
});
