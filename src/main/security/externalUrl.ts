const MAX_EXTERNAL_URL_LENGTH = 4_096;

export function normalizeExternalHttpUrl(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > MAX_EXTERNAL_URL_LENGTH) return undefined;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}
