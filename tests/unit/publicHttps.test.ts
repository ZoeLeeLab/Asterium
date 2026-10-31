import { describe, expect, it, vi } from 'vitest';
import { assertPublicHostname, requestPublicHttps, validatePublicHttpsUrl } from '../../src/main/security/PublicHttps';

const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }] as never);

describe('public HTTPS boundary', () => {
  it('rejects non-HTTPS, credential URLs and private addresses', async () => {
    expect(() => validatePublicHttpsUrl('http://example.com')).toThrow('REMOTE_URL_REJECTED');
    expect(() => validatePublicHttpsUrl('https://user:secret@example.com')).toThrow('REMOTE_URL_REJECTED');
    await expect(assertPublicHostname('127.0.0.1')).rejects.toThrow('REMOTE_URL_REJECTED');
    await expect(assertPublicHostname('metadata.test', 'REMOTE_URL_REJECTED', vi.fn(async () => [{ address: '169.254.169.254', family: 4 }] as never))).rejects.toThrow('REMOTE_URL_REJECTED');
    await expect(assertPublicHostname('private.test', 'REMOTE_URL_REJECTED', vi.fn(async () => [{ address: 'fd00::1', family: 6 }] as never))).rejects.toThrow('REMOTE_URL_REJECTED');
  });

  it('revalidates redirects and refuses a private redirect target', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } }));
    await expect(requestPublicHttps('https://example.com/start', { fetcher, lookupHost: publicLookup, maxBytes: 1024 })).rejects.toThrow('WEB_URL_REJECTED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('limits streamed responses and honors cancellation', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(32)));
    await expect(requestPublicHttps('https://example.com/large', { fetcher, lookupHost: publicLookup, maxBytes: 8 })).rejects.toThrow('WEB_RESPONSE_TOO_LARGE');

    const controller = new AbortController();
    controller.abort();
    await expect(requestPublicHttps('https://example.com/cancelled', { fetcher, lookupHost: publicLookup, maxBytes: 64, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not follow redirects when a credential-bearing caller forbids them', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://other.example/path' } }));
    await expect(requestPublicHttps('https://api.example/search', { fetcher, lookupHost: publicLookup, maxBytes: 1024, followRedirects: false, errorPrefix: 'SEARCH' })).rejects.toThrow('SEARCH_REDIRECT_REJECTED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
