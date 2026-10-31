import { describe, expect, it, vi } from 'vitest';
import { ApiWebTools } from '../../src/main/api/ApiWebTools';

const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }] as never);
const signal = new AbortController().signal;

describe('ApiWebTools', () => {
  it('prefers Brave, returns normalized results and never returns its key', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('country')).toBe('CN');
      expect(url.searchParams.get('search_lang')).toBe('zh');
      expect(url.searchParams.get('ui_lang')).toBe('zh-CN');
      expect(new Headers(init?.headers).get('Accept-Language')).toBe('zh-CN,zh;q=0.9');
      expect(new Headers(init?.headers).get('Cache-Control')).toBe('no-cache');
      expect(new Headers(init?.headers).get('X-Subscription-Token')).toBe('brave-secret');
      return new Response(JSON.stringify({ web: { results: [{ title: 'Example &amp; source', url: 'https://example.com/a', description: 'Useful <b>snippet</b>' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const tools = new ApiWebTools({ braveApiKey: async () => 'brave-secret', fetcher, lookupHost: publicLookup });

    const result = JSON.parse(await tools.execute('web_search', { query: 'OpenAI 最新消息', max_results: 3 }, signal));

    expect(result).toMatchObject({ query: 'OpenAI 最新消息', language: 'zh-CN', region: 'CN', backend: 'brave', warnings: [], results: [{ title: 'Example & source', url: 'https://example.com/a', snippet: 'Useful snippet' }] });
    expect(JSON.stringify(result)).not.toContain('brave-secret');
  });

  it('falls back from Brave to DuckDuckGo and then Bing with safe warning codes', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://api.search.brave.com/')) return new Response('denied', { status: 401 });
      if (url.startsWith('https://lite.duckduckgo.com/')) return new Response('unavailable', { status: 503 });
      return new Response('<?xml version="1.0"?><rss><channel><item><title>Story title</title><link>https://example.com/story</link><description>Story &amp; details</description></item></channel></rss>', { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
    });
    const tools = new ApiWebTools({ braveApiKey: async () => 'invalid-secret', fetcher, lookupHost: publicLookup });

    const result = JSON.parse(await tools.execute('web_search', { query: 'story' }, signal));

    expect(calls.map((value) => new URL(value).hostname)).toEqual(['api.search.brave.com', 'lite.duckduckgo.com', 'www.bing.com']);
    expect(result.backend).toBe('bing_rss');
    expect(result.warnings).toEqual([
      { backend: 'brave', error: 'BRAVE_SEARCH_HTTP_401' },
      { backend: 'duckduckgo_lite', error: 'DUCKDUCKGO_SEARCH_HTTP_503' },
    ]);
    expect(result.results[0]).toEqual({ title: 'Story title', url: 'https://example.com/story', snippet: 'Story & details' });
    expect(JSON.stringify(result)).not.toContain('invalid-secret');
  });

  it('uses DuckDuckGo directly without a key and parses Lite results', async () => {
    const fetcher = vi.fn(async () => new Response("<a rel='nofollow' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst&amp;rut=x' class='result-link'>First &amp; best</a><td class='result-snippet'>A <b>fresh</b> result</td>", { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const tools = new ApiWebTools({ fetcher, lookupHost: publicLookup });

    const result = JSON.parse(await tools.execute('web_search', { query: 'first' }, signal));

    expect(result).toMatchObject({ language: 'en-US', region: 'US', backend: 'duckduckgo_lite', results: [{ title: 'First & best', url: 'https://example.com/first', snippet: 'A fresh result' }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('falls back after a malformed Brave response without exposing response contents', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).startsWith('https://api.search.brave.com/')
      ? new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response("<a href='https://example.com/fallback' class='result-link'>Fallback</a><td class='result-snippet'>Safe result</td>", { status: 200, headers: { 'content-type': 'text/html' } }));
    const tools = new ApiWebTools({ braveApiKey: async () => 'secret', fetcher, lookupHost: publicLookup });

    const result = JSON.parse(await tools.execute('web_search', { query: 'fallback' }, signal));

    expect(result.backend).toBe('duckduckgo_lite');
    expect(result.warnings).toEqual([{ backend: 'brave', error: 'BRAVE_SEARCH_INVALID_RESPONSE' }]);
    expect(JSON.stringify(result)).not.toContain('not-json');
  });

  it('reports a stable failure when every search backend fails', async () => {
    const tools = new ApiWebTools({ fetcher: vi.fn(async () => new Response('unavailable', { status: 503 })), lookupHost: publicLookup });
    await expect(tools.execute('web_search', { query: 'unavailable' }, signal)).rejects.toThrow('WEB_SEARCH_ALL_PROVIDERS_FAILED');
  });

  it('times out a stalled search request', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const tools = new ApiWebTools({ fetcher, lookupHost: publicLookup, requestTimeoutMs: 5 });
    await expect(tools.execute('web_search', { query: 'slow' }, signal)).rejects.toThrow('WEB_SEARCH_ALL_PROVIDERS_FAILED');
  });

  it('extracts readable HTML in chunks and caches the page for the current run', async () => {
    const fetcher = vi.fn(async () => new Response('<html><head><title>Page &amp; title</title><style>hidden</style></head><body><h1>Hello</h1><p>World <b>today</b>.</p><script>ignore()</script></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const tools = new ApiWebTools({ fetcher, lookupHost: publicLookup });

    const first = JSON.parse(await tools.execute('web_fetch', { url: 'https://example.com/page', max_characters: 8 }, signal));
    const second = JSON.parse(await tools.execute('web_fetch', { url: 'https://example.com/page', offset: first.nextOffset, max_characters: 32 }, signal));

    expect(first).toMatchObject({ title: 'Page & title', contentType: 'text/html', offset: 0, nextOffset: 8, eof: false, truncated: false });
    expect(`${first.content}${second.content}`).toContain('Hello');
    expect(`${first.content}${second.content}`).toContain('World today.');
    expect(`${first.content}${second.content}`).not.toContain('ignore');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects private pages and unsupported binary content', async () => {
    const tools = new ApiWebTools({ fetcher: vi.fn(async () => new Response('pdf', { headers: { 'content-type': 'application/pdf' } })), lookupHost: publicLookup });
    await expect(tools.execute('web_fetch', { url: 'https://127.0.0.1/private' }, signal)).rejects.toThrow('WEB_FETCH_URL_REJECTED');
    await expect(tools.execute('web_fetch', { url: 'https://example.com/file.pdf' }, signal)).rejects.toThrow('WEB_FETCH_UNSUPPORTED_CONTENT_TYPE');
  });

  it('drops unsafe result URLs returned by a search provider', async () => {
    const fetcher = vi.fn(async () => new Response("<a href='javascript:alert(1)' class='result-link'>Unsafe</a><td class='result-snippet'>Ignore me</td><a href='https://example.com/safe' class='result-link'>Safe</a><td class='result-snippet'>Keep me</td>", { headers: { 'content-type': 'text/html' } }));
    const tools = new ApiWebTools({ fetcher, lookupHost: publicLookup });
    const result = JSON.parse(await tools.execute('web_search', { query: 'urls' }, signal));
    expect(result.results).toEqual([{ title: 'Safe', url: 'https://example.com/safe', snippet: 'Keep me' }]);
  });

  it.each([
    ['上海天气', 'zh-CN', 'CN', 'cn-zh'],
    ['서울 날씨', 'ko-KR', 'KR', 'kr-kr'],
    ['東京の天気', 'ja-JP', 'JP', 'jp-jp'],
    ['OpenAI news', 'en-US', 'US', 'us-en'],
    ['OpenAI 最新消息', 'zh-CN', 'CN', 'cn-zh'],
  ])('derives a stable locale from %s instead of the proxy location', async (query, language, region, duckDuckGoRegion) => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('kl')).toBe(duckDuckGoRegion);
      expect(new Headers(init?.headers).get('Accept-Language')).toBe(`${language},${language.split('-')[0]};q=0.9`);
      return new Response("<a href='https://example.com/result' class='result-link'>Result</a><td class='result-snippet'>Relevant</td>", { headers: { 'content-type': 'text/html' } });
    });
    const tools = new ApiWebTools({ fetcher, lookupHost: publicLookup });

    const result = JSON.parse(await tools.execute('web_search', { query }, signal));

    expect(result).toMatchObject({ query, language, region, backend: 'duckduckgo_lite' });
  });

  it('passes the derived locale to the final Bing fallback', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'lite.duckduckgo.com') return new Response('unavailable', { status: 503 });
      expect(url.searchParams.get('mkt')).toBe('zh-CN');
      expect(url.searchParams.get('setlang')).toBe('zh-CN');
      expect(url.searchParams.get('cc')).toBe('CN');
      expect(new Headers(init?.headers).get('Accept-Language')).toBe('zh-CN,zh;q=0.9');
      return new Response('<?xml version="1.0"?><rss><channel><item><title>天气</title><link>https://example.com/weather</link><description>上海天气</description></item></channel></rss>', { headers: { 'content-type': 'text/xml' } });
    });
    const tools = new ApiWebTools({ fetcher, lookupHost: publicLookup });

    const result = JSON.parse(await tools.execute('web_search', { query: '上海天气' }, signal));

    expect(result).toMatchObject({ language: 'zh-CN', region: 'CN', backend: 'bing_rss' });
    expect(result.warnings).toEqual([{ backend: 'duckduckgo_lite', error: 'DUCKDUCKGO_SEARCH_HTTP_503' }]);
  });
});
