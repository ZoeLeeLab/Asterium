import { describe, expect, it } from 'vitest';
import { normalizeExternalHttpUrl } from '../../src/main/security/externalUrl';

describe('normalizeExternalHttpUrl', () => {
  it('allows ordinary HTTP and HTTPS links for the system browser', () => {
    expect(normalizeExternalHttpUrl('https://example.com/docs?q=星丛')).toBe('https://example.com/docs?q=%E6%98%9F%E4%B8%9B');
    expect(normalizeExternalHttpUrl('http://127.0.0.1:5173/preview')).toBe('http://127.0.0.1:5173/preview');
  });

  it('rejects credentials, executable schemes, malformed values, and oversized URLs', () => {
    expect(normalizeExternalHttpUrl('https://user:secret@example.com/')).toBeUndefined();
    expect(normalizeExternalHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeExternalHttpUrl('file:///C:/Windows/System32/calc.exe')).toBeUndefined();
    expect(normalizeExternalHttpUrl('mailto:fixture-user@example.com')).toBeUndefined();
    expect(normalizeExternalHttpUrl('not a url')).toBeUndefined();
    expect(normalizeExternalHttpUrl(`https://example.com/${'x'.repeat(4_096)}`)).toBeUndefined();
  });
});
