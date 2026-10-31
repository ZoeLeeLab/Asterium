import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ProjectBrowseRequest, ProjectBrowseResult, ProjectGitChange } from '../../shared/projectBrowser';
import { decodeProjectContent, readProjectContent } from './ProjectContentReader';
import type { ProjectWorkspaceSnapshot } from '../../shared/projectWorkspace';

const exec = promisify(execFile);
const base = { projectId: z.string().min(1).max(128) };
const rel = z.string().max(4096);
const rev = z.string().regex(/^[a-f0-9]{40,64}$/i);
export const projectBrowseSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('directory'), path: rel.optional() }).strict(),
  z.object({ ...base, action: z.literal('file'), path: rel.optional(), fileId: z.string().max(128).optional(), revision: rev.optional() }).strict(),
  z.object({ ...base, action: z.literal('status') }).strict(),
  z.object({ ...base, action: z.literal('history'), offset: z.number().int().min(0).max(100000).optional() }).strict(),
  z.object({ ...base, action: z.literal('changes'), revision: rev.optional() }).strict(),
  z.object({ ...base, action: z.literal('diff'), path: rel, revision: rev.optional(), group: z.enum(['staged', 'unstaged', 'untracked']).optional() }).strict(),
]);

export class ProjectBrowserService {
  constructor(private readonly workspaces: { get(id: string): Promise<ProjectWorkspaceSnapshot | undefined> }, private readonly files: { resolve(projectId: string, fileId: string): Promise<string> }) {}

  async root(projectId: string) {
    const workspace = await this.workspaces.get(projectId);
    if (!workspace) throw new Error('PROJECT_WORKSPACE_NOT_READY');
    return realpath(workspace.rootPath);
  }

  async safePath(root: string, relative: string, future = false) {
    if (relative.includes('\0') || relative.includes(':') || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === '..' || part.toLowerCase() === '.git')) throw new Error('PROJECT_FILE_PATH_REJECTED');
    const candidate = path.resolve(root, relative);
    let cursor = candidate;
    for (;;) {
      try {
        const canonical = await realpath(cursor);
        if (!contained(root, canonical)) throw new Error('PROJECT_FILE_PATH_REJECTED');
        break;
      } catch (error) {
        if (!future || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
      }
    }
    return candidate;
  }

  async git(root: string, args: string[], binary = false): Promise<Buffer> {
    // Trust only the user-selected repository for this command; never alter global config.
    let repo = root;
    while (!await lstat(path.join(repo, '.git')).catch(() => undefined)) {
      const parent = path.dirname(repo);
      if (parent === repo) throw new Error('PROJECT_GIT_UNAVAILABLE');
      repo = parent;
    }
    const { stdout } = await exec('git', ['--no-pager', '--literal-pathspecs', '-c', `safe.directory=${repo}`, '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-C', root, ...args], {
      encoding: 'buffer', windowsHide: true, timeout: 15000, maxBuffer: binary ? 30 * 1024 * 1024 : 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  }

  async query(raw: ProjectBrowseRequest): Promise<ProjectBrowseResult> {
    const request = projectBrowseSchema.parse(raw);
    const root = await this.root(request.projectId);
    if (request.action === 'directory') {
      const directory = await this.safePath(root, request.path ?? '');
      const children = await readdir(directory, { withFileTypes: true });
      if (children.length > 20000) throw new Error('PROJECT_DIRECTORY_TOO_LARGE');
      return { entries: children.filter((item) => item.name.toLowerCase() !== '.git' && !item.isSymbolicLink() && (item.isDirectory() || item.isFile())).map((item) => ({ name: item.name, path: path.relative(root, path.join(directory, item.name)).replaceAll('\\', '/'), directory: item.isDirectory() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN')) };
    }
    if (request.action === 'file') {
      const relative = request.fileId ? path.relative(root, await this.files.resolve(request.projectId, request.fileId)) : request.path;
      if (!relative) throw new Error('PROJECT_FILE_PATH_REJECTED');
      const file = await this.safePath(root, relative, Boolean(request.revision));
      if (!request.revision) return { content: await readProjectContent(file, relative) };
      const prefix = (await this.git(root, ['rev-parse', '--show-prefix'])).toString().trim();
      return { content: decodeProjectContent(path.basename(relative), relative, await this.git(root, ['show', `${request.revision}:${prefix}${relative.replaceAll('\\', '/')}`], true)) };
    }
    let head: string | undefined;
    try { await this.git(root, ['rev-parse', '--show-toplevel']); } catch { return { git: 'unavailable' }; }
    try { head = (await this.git(root, ['rev-parse', '--verify', 'HEAD'])).toString().trim(); } catch { /* unborn branch */ }
    if (request.action === 'status' || (request.action === 'changes' && !request.revision)) {
      const prefix = (await this.git(root, ['rev-parse', '--show-prefix'])).toString().trim();
      const parts = (await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])).toString().split('\0');
      const changes: ProjectGitChange[] = [];
      for (let i = 0; i < parts.length; i++) {
        const item = parts[i]; if (!item) continue;
        const status = item.slice(0, 2); const rawPath = item.slice(3);
        const rawOldPath = /[RC]/.test(status) ? parts[++i] : undefined;
        if (prefix && !rawPath.startsWith(prefix)) {
          if (rawOldPath?.startsWith(prefix)) changes.push({ path: rawOldPath.slice(prefix.length), status: 'D', group: status[0] !== ' ' ? 'staged' : 'unstaged' });
          continue;
        }
        const file = rawPath.slice(prefix.length);
        const oldPath = rawOldPath?.startsWith(prefix) ? rawOldPath.slice(prefix.length) : undefined;
        if (status === '??') changes.push({ path: file, status: 'A', group: 'untracked' });
        else {
          if (status[0] !== ' ') changes.push({ path: file, oldPath, status: status[0], group: 'staged' });
          if (status[1] !== ' ') changes.push({ path: file, oldPath, status: status[1], group: 'unstaged' });
        }
      }
      return { git: head ? 'ready' : 'empty', head, changes };
    }
    if (request.action === 'history') {
      if (!head) return { git: 'empty', commits: [] };
      const raw = (await this.git(root, ['log', '-31', `--skip=${request.offset ?? 0}`, '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%b%x00%x1e', '--', '.'])).toString();
      const commits = raw.split('\x1e').map((record) => record.replace(/^\n/, '').split('\0')).filter((fields) => fields.length >= 6).map(([sha, shortSha, author, date, subject, body]) => ({ sha, shortSha, author, date, subject, body }));
      return { git: 'ready', commits: commits.slice(0, 30), more: commits.length > 30, head };
    }
    if (request.action === 'changes') {
      const revision = request.revision!;
      const parts = (await this.git(root, ['diff-tree', '--root', '--no-commit-id', '-r', '-m', '--first-parent', '--name-status', '-z', '--relative', '-M', revision, '--', '.'])).toString().split('\0');
      const changes: ProjectGitChange[] = [];
      for (let i = 0; i < parts.length;) {
        const status = parts[i++]; if (!status) continue;
        const first = parts[i++];
        if (/^[RC]/.test(status)) changes.push({ status: status[0], oldPath: first, path: parts[i++] });
        else changes.push({ status, path: first });
      }
      return { git: 'ready', changes };
    }
    await this.safePath(root, request.path, true);
    if (request.group === 'untracked') return { content: await readProjectContent(await this.safePath(root, request.path), request.path) };
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--relative', '--no-color'];
    if (request.revision) {
      let parent = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      try { parent = (await this.git(root, ['rev-parse', `${request.revision}^1`])).toString().trim(); } catch { /* root commit */ }
      args.push(parent, request.revision);
    } else if (request.group === 'staged') args.push('--cached');
    args.push('--', request.path);
    const diff = (await this.git(root, args)).toString();
    let content;
    try {
      if (request.revision) content = (await this.query({ projectId: request.projectId, action: 'file', path: request.path, revision: request.revision })).content;
      else if (request.group === 'staged') {
        const prefix = (await this.git(root, ['rev-parse', '--show-prefix'])).toString().trim();
        content = decodeProjectContent(path.basename(request.path), request.path, await this.git(root, ['show', `:${prefix}${request.path}`], true));
      } else content = await readProjectContent(await this.safePath(root, request.path), request.path);
    } catch { /* deleted file: diff is authoritative */ }
    return { content: { name: path.basename(request.path), path: request.path, info: { previewKind: 'text' }, ...content, diff } };
  }
}

export function contained(root: string, candidate: string) { const relative = path.relative(root, candidate); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }
