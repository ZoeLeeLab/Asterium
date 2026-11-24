export function archivedMarkdownFileName(name: string, suffix: string) {
  const withoutControlCharacters = [...name].map((character) => character.charCodeAt(0) < 32 ? '_' : character).join('');
  const safeName = withoutControlCharacters.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 120) || '项目';
  return `${safeName}-${suffix}.md`;
}
