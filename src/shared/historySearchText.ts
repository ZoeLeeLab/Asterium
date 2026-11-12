export function normalizeHistoryQuery(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

export function searchableHistoryText(text: string) {
  const body = normalizeHistoryQuery(text);
  const visible = body.replace(/!?\[([^\]\n]+)\]\([^\n)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  return visible === body ? body : body + '\n' + visible;
}
