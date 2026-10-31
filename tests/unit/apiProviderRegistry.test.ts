import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProviderRegistry, createDefaultApiProviderRegistry, deepSeekProviderDefinition } from '../../src/main/api/ApiProviderRegistry';
import { DeepSeekHttpError } from '../../src/main/adapters/DeepSeekProviderAdapter';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiProviderRegistry', () => {
  it('registers legacy DeepSeek and generic Chat Completions', () => {
    const registry = createDefaultApiProviderRegistry();
    expect(registry.has('deepseek')).toBe(true);
    expect(registry.has('openai')).toBe(true);
    expect(registry.has('anthropic')).toBe(true);
    expect(registry.has('custom')).toBe(false);
    expect(registry.require('openai').normalizeEndpoint('https://example.com/v1')).toBe('https://example.com/v1/chat/completions');
  });

  it('normalizes DeepSeek connections without changing the connection object', () => {
    const registry = createDefaultApiProviderRegistry();
    const connection = {
      provider: 'deepseek' as const,
      endpoint: ' https://api.deepseek.com/chat/completions?ignored=yes#fragment ',
      model: ' deepseek-chat ',
      credentialRef: 'credential-one',
    };
    expect(registry.normalizeConnection(connection)).toMatchObject({
      definition: { id: 'deepseek' },
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
    });
    expect(connection).toEqual({
      provider: 'deepseek',
      endpoint: ' https://api.deepseek.com/chat/completions?ignored=yes#fragment ',
      model: ' deepseek-chat ',
      credentialRef: 'credential-one',
    });
    expect(() => registry.normalizeConnection({ ...connection, model: ' ' })).toThrow('API_MODEL_REQUIRED');
    expect(() => registry.normalizeConnection({ ...connection, endpoint: 'https://example.com/chat/completions' })).toThrow('INVALID_DEEPSEEK_ENDPOINT');
  });

  it('routes model listing and adapter construction through the DeepSeek definition', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'deepseek-chat', owned_by: 'deepseek' },
      { id: 'deepseek-chat', owned_by: 'duplicate' },
      { id: 'deepseek-reasoner' },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const registry = createDefaultApiProviderRegistry();
    await expect(registry.listModels('deepseek', 'https://api.deepseek.com/chat/completions', 'secret')).resolves.toEqual([
      { id: 'deepseek-chat', ownedBy: 'duplicate' },
      { id: 'deepseek-reasoner' },
    ]);
    expect(fetcher).toHaveBeenCalledWith('https://api.deepseek.com/models', expect.objectContaining({
      method: 'GET',
      headers: { Authorization: 'Bearer secret' },
    }));
    const adapter = registry.require('deepseek').createAdapter({
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      apiKey: 'secret',
    });
    expect(adapter.provider).toBe('deepseek');
    expect(adapter.capabilities.attachments.attachmentTransport).toBe('metadata_only');
  });

  it('owns DeepSeek presentation, finish and transport error mapping', () => {
    const policy = createDefaultApiProviderRegistry().require('deepseek').runtimePolicy;
    expect(policy.reasoningSummary(1)).toBe('DeepSeek 正在思考…');
    expect(policy.reasoningSummary(2)).toBe('DeepSeek 第 2 段思考…');
    expect(policy.finishReasonError('content_filter')).toEqual({
      code: 'DEEPSEEK_CONTENT_FILTERED', message: 'DeepSeek 因内容安全策略停止了回复。', stage: 'adapter', retryable: false,
    });
    expect(policy.finishReasonError('insufficient_system_resource')).toEqual({
      code: 'DEEPSEEK_CAPACITY', message: 'DeepSeek 当前资源不足，请稍后重试。', stage: 'transport', retryable: true,
    });
    expect(policy.finishReasonError('stop')).toBeUndefined();
    expect(policy.mapError(new DeepSeekHttpError(401))).toMatchObject({ code: 'DEEPSEEK_AUTH_FAILED', retryable: false });
    expect(policy.mapError(new DeepSeekHttpError(429))).toMatchObject({ code: 'DEEPSEEK_RATE_LIMITED', retryable: true });
    expect(policy.mapError(new DeepSeekHttpError(503))).toMatchObject({ code: 'DEEPSEEK_UNAVAILABLE', retryable: true });
    expect(policy.mapError(new DeepSeekHttpError(409))).toMatchObject({ code: 'DEEPSEEK_HTTP_ERROR', retryable: true });
    expect(policy.mapError(new Error('DEEPSEEK_MALFORMED_SSE'))).toMatchObject({ code: 'DEEPSEEK_MALFORMED_SSE' });
    expect(policy.mapError(new Error('DEEPSEEK_STREAM_INTERRUPTED'))).toMatchObject({ code: 'DEEPSEEK_STREAM_INTERRUPTED' });
    expect(policy.mapError(new Error('DEEPSEEK_EMPTY_STREAM'))).toMatchObject({ code: 'DEEPSEEK_EMPTY_STREAM' });
    expect(policy.mapError(new Error('sensitive transport detail'))).toEqual({
      code: 'DEEPSEEK_NETWORK_ERROR', message: '无法连接 DeepSeek，请检查网络或代理后重试。', stage: 'transport', retryable: true,
    });
  });

  it('rejects duplicate provider registration', () => {
    expect(() => new ApiProviderRegistry([deepSeekProviderDefinition, deepSeekProviderDefinition])).toThrow('API_PROVIDER_ALREADY_REGISTERED');
  });
});
