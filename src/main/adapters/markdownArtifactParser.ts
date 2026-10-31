import path from 'node:path';
import type { ArtifactSourceClaim } from '../../shared/agentProtocol';

export interface MarkdownImageClaim {
  name: string;
  mediaType?: string;
  source: ArtifactSourceClaim;
}

export class MarkdownArtifactParser {
  private pending = '';
  private readonly seen = new Set<string>();

  flush() {
    const text = this.pending;
    this.pending = '';
    return text;
  }

  push(chunk: string) {
    this.pending += chunk;
    let text = '';
    const claims: MarkdownImageClaim[] = [];
    let cursor = 0;
    for (;;) {
      const start = this.pending.indexOf('![', cursor);
      if (start < 0) {
        const remainder = this.pending.slice(cursor);
        if (remainder.endsWith('!')) {
          text += remainder.slice(0, -1);
          this.pending = '!';
        } else {
          text += remainder;
          this.pending = '';
        }
        break;
      }
      const labelEnd = this.pending.indexOf('](', start + 2);
      if (labelEnd < 0) {
        text += this.pending.slice(cursor, start);
        this.pending = this.pending.slice(start);
        break;
      }
      const sourceEnd = this.pending.indexOf(')', labelEnd + 2);
      if (sourceEnd < 0) {
        text += this.pending.slice(cursor, start);
        this.pending = this.pending.slice(start);
        break;
      }
      text += this.pending.slice(cursor, start);
      const alt = this.pending.slice(start + 2, labelEnd).trim();
      const rawSource = this.pending.slice(labelEnd + 2, sourceEnd).trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
      const marker = this.pending.slice(start, sourceEnd + 1);
      const claim = imageClaim(rawSource, alt);
      if (claim && !this.seen.has(marker)) {
        this.seen.add(marker);
        claims.push(claim);
      } else if (!claim) text += marker;
      cursor = sourceEnd + 1;
      if (cursor >= this.pending.length) {
        this.pending = '';
        break;
      }
    }
    if (this.pending.length > 32_768) {
      text += this.pending;
      this.pending = '';
    }
    return { text, claims };
  }
}

function imageClaim(source: string, alt: string): MarkdownImageClaim | undefined {
  if (!source) return undefined;
  let claim: ArtifactSourceClaim;
  if (/^https:\/\//i.test(source)) claim = { kind: 'content', transport: 'https_url', value: source };
  else if (/^data:image\//i.test(source)) claim = { kind: 'content', transport: 'data_url', value: source };
  else if (/^asterium-remote:\/\//i.test(source)) {
    const value = new URL(source);
    claim = { kind: 'remote_ref', provider: value.hostname, reference: `${value.pathname}${value.search}` };
  } else if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(source) || /^\.{0,2}[\\/]/.test(source)) claim = { kind: 'local_path', path: source };
  else return undefined;
  const fallback = source.startsWith('data:') ? '图片' : path.basename(source.replace(/\\/g, '/').split(/[?#]/)[0]) || '图片';
  const name = alt && /\.[a-zA-Z0-9]{2,8}$/.test(alt) ? alt : fallback;
  const mediaType = /^data:([^;,]+)/i.exec(source)?.[1];
  return { name, mediaType, source: claim };
}
