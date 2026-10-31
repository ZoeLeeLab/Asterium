// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { listApiSiteModels } from '../../src/main/api/listApiSiteModels';
import { API_SITE_PRESETS } from '../../src/shared/apiPresets';
import { apiEndpoint, apiModelsEndpoint } from '../../src/shared/apiEndpoints';

describe('site model catalog', () => {
  it('resolves all five presets without duplicated version paths', () => {
    expect(API_SITE_PRESETS.map(preset => apiEndpoint(preset.endpoint, preset.protocol))).toEqual([
      'https://api.deepseek.com/chat/completions', 'https://api.moonshot.cn/v1/chat/completions',
      'https://api.openai.com/v1/responses', 'https://api.anthropic.com/v1/messages', 'https://api.siliconflow.cn/v1/chat/completions',
    ]);
    for (const preset of API_SITE_PRESETS) expect(apiModelsEndpoint(preset.endpoint, preset.protocol)).toMatch(/\/models$/);
  });
  it('reads every Anthropic page, deduplicates models and keeps credentials on the original origin', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'a' }, { id: 'b' }], has_more: false }));
    expect(await listApiSiteModels('https://fixture.invalid/v1/models', 'anthropic_messages', { 'x-api-key': 'synthetic' }, undefined, fetcher)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(fetcher.mock.calls[1][0]).toBe('https://fixture.invalid/v1/models?after_id=a');
    expect(fetcher.mock.calls[1][1].headers).toEqual({ 'x-api-key': 'synthetic' });
  });
  it('follows Gemini page tokens and rejects a repeated cursor instead of looping', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ models: [{ name: 'models/a' }], nextPageToken: 'token' }))
      .mockResolvedValueOnce(Response.json({ models: [{ name: 'models/b' }] }));
    expect(await listApiSiteModels('https://fixture.invalid/v1beta/models', 'gemini', {}, undefined, fetcher)).toEqual([{ id: 'models/a' }, { id: 'models/b' }]);
    expect(fetcher.mock.calls[1][0]).toContain('pageToken=token');
    const repeated = vi.fn(async () => Response.json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }));
    await expect(listApiSiteModels('https://fixture.invalid/models', 'anthropic_messages', {}, undefined, repeated)).rejects.toThrow('API_MODELS_INVALID_CURSOR');
    expect(repeated).toHaveBeenCalledTimes(2);
  });
  it('does not retry network failures or silently accept a malformed catalog', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline'); });
    await expect(listApiSiteModels('https://fixture.invalid/models', 'chat_completions', {}, undefined, fetcher)).rejects.toThrow('offline');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(listApiSiteModels('https://fixture.invalid/models', 'chat_completions', {}, undefined, async () => Response.json({ error: 'bad catalog' }))).rejects.toThrow('API_MODELS_INVALID');
  });
});
