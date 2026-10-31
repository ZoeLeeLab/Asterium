import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { ProjectPreviewContent, ProjectPreviewKind } from '../../shared/projectBrowser';

export function projectPreviewKind(name: string, mediaType = ''): ProjectPreviewKind {
  const ext = path.extname(name).toLowerCase();
  if (['.md', '.markdown'].includes(ext) || mediaType === 'text/markdown') return 'markdown';
  if (['.html', '.htm'].includes(ext) || mediaType === 'text/html') return 'html';
  if (ext === '.pdf' || mediaType === 'application/pdf') return 'pdf';
  if (ext === '.docx') return 'word';
  if (['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods', '.csv'].includes(ext)) return 'sheet';
  if (ext === '.pptx') return 'slides';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext) || mediaType.startsWith('image/')) return 'image';
  if (/^\.(txt|json|jsonc|js|jsx|ts|tsx|mjs|cjs|css|scss|sass|less|py|rs|go|java|c|h|cpp|hpp|cs|rb|php|sh|bash|ps1|sql|xml|yaml|yml|toml|ini|conf|log|vue|svelte|gitignore|env|lock)$/i.test(ext) || mediaType.startsWith('text/') || ['Dockerfile', 'Makefile', '.gitignore', '.env'].includes(path.basename(name))) return 'text';
  return 'unsupported';
}

export function decodeProjectContent(name: string, relativePath: string, bytes: Buffer): ProjectPreviewContent {
  let previewKind = projectPreviewKind(name);
  if (previewKind === 'unsupported' && bytes.length <= 5 * 1024 * 1024 && !bytes.includes(0)) {
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (![...text.slice(0, 8192)].some((character) => character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0)))) previewKind = 'text'; } catch { /* binary format */ }
  }
  const result: ProjectPreviewContent = { name, path: relativePath, info: { previewKind } };
  const text = ['text', 'markdown', 'html'].includes(previewKind);
  if (bytes.length > (text ? 5 : 30) * 1024 * 1024) throw new Error('PROJECT_PREVIEW_TOO_LARGE');
  if (text) {
    if (bytes.includes(0)) return { ...result, info: { previewKind: 'unsupported' }, binary: true };
    result.text = bytes.toString('utf8');
  } else if (previewKind !== 'unsupported') {
    const ext = path.extname(name).slice(1).toLowerCase();
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf' } as Record<string, string>)[ext] ?? 'application/octet-stream';
    result.dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  }
  return result;
}

export async function readProjectContent(file: string, relativePath: string) {
  const value = await stat(file);
  if (!value.isFile()) throw new Error('PROJECT_FILE_NOT_FOUND');
  if (value.size > 30 * 1024 * 1024) throw new Error('PROJECT_PREVIEW_TOO_LARGE');
  return decodeProjectContent(path.basename(file), relativePath, await readFile(file));
}
