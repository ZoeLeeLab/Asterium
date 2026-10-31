import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PartnerEvent, SendMessageCommand } from '../../shared/agentProtocol';
import type { ProjectRunChange, ProjectRunChangedFile, ProjectRunChangeRead } from '../../shared/projectRunChanges';
import type { ProjectPreviewContent } from '../../shared/projectBrowser';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';
import { ProjectBrowserService } from './ProjectBrowserService';
import { decodeProjectContent } from './ProjectContentReader';

interface SnapshotFile { hash: string; blob?: string }
interface RunContext { attemptId?: string; taskId?: string; title?: string; purpose?: string; control?: string }
interface ActiveChange {
  record: ProjectRunChange; root: string; baseline: Record<string, SnapshotFile>; head?: string; known: Set<string>; commands: string[];
  tools: Map<string, { name: string; detail: string; command: string; paths: string[]; mutates: boolean }>; uncertain: boolean;
}
const ignored = new Set(['.git', 'node_modules', '.vite', 'out', 'dist', 'build', '.next', '.qa', '__pycache__']);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export class ProjectRunChangeRecorder {
  private readonly active = new Map<string, ActiveChange>();
  private readonly starting = new Map<string, string>();
  constructor(private readonly directory: () => string, private readonly browser: ProjectBrowserService, private readonly roomProject: (roomId: string) => Promise<string | undefined>, private readonly context: (command: SendMessageCommand) => RunContext | undefined, private readonly publish: (projectId: string) => void = () => undefined) {}

  private projectDirectory(projectId: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectId)) throw new Error('PROJECT_CHANGE_ID_INVALID');
    return path.join(this.directory(), projectId);
  }
  private store(projectId: string, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('PROJECT_CHANGE_ID_INVALID');
    return new AtomicJsonStore<ProjectRunChange | undefined>({ filePath: path.join(this.projectDirectory(projectId), `${id}.json`), empty: () => undefined, decode: (value) => {
      const record = value as ProjectRunChange;
      if (record?.version !== 1 || record.id !== id || record.projectId !== projectId || !Array.isArray(record.files) || !Array.isArray(record.verification)) throw new Error('PROJECT_CHANGE_RECORD_INVALID');
      return record;
    } });
  }
  private async blob(projectId: string, bytes: Buffer) {
    const digest = hash(bytes); const folder = path.join(this.projectDirectory(projectId), 'blobs'); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, digest), bytes, { flag: 'wx', mode: 0o600 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    return digest;
  }
  private async bytes(projectId: string, digest?: string) {
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) return undefined;
    return readFile(path.join(this.projectDirectory(projectId), 'blobs', digest));
  }
  async capture(projectId: string, root: string, warn: (message: string) => void): Promise<Record<string, SnapshotFile>> {
    let paths: string[];
    try { paths = (await this.browser.git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'])).toString().split('\0').filter(Boolean); }
    catch {
      paths = [];
      const walk = async (directory: string) => {
        for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
          if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
          if (paths.length >= 10000) { warn('项目文件过多，快照范围不完整'); return; }
          const relative = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(relative); else if (entry.isFile()) paths.push(relative);
        }
      }; await walk('');
    }
    const result: Record<string, SnapshotFile> = Object.create(null); let used = 0;
    if (paths.length > 10000) warn('项目文件过多，快照范围不完整');
    for (const relative of [...new Set(paths)].slice(0, 10000)) {
      const normalized = relative.replaceAll('\\', '/');
      try {
        const file = await this.browser.safePath(root, relative); const before = await lstat(file);
        if (!before.isFile() || before.isSymbolicLink()) continue;
        if (before.size > 1024 * 1024 || used + before.size > 64 * 1024 * 1024) {
          result[normalized] = { hash: `metadata:${before.size}:${before.mtimeMs}` }; warn('部分文件超过快照大小限制'); continue;
        }
        const bytes = await readFile(file); const after = await lstat(file); used += bytes.length;
        if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) warn('采集期间文件发生变化');
        result[normalized] = { hash: hash(bytes), blob: await this.blob(projectId, bytes) };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('部分文件无法采集或不在项目安全范围内'); }
    }
    return result;
  }

  async begin(command: SendMessageCommand) {
    if (!command.route || !['group', 'workspace'].includes(command.route.scope)) return;
    const projectId = command.route.scope === 'workspace' ? command.route.projectId : command.route.scope === 'group' ? await this.roomProject(command.route.roomId) : undefined;
    if (!projectId) return;
    const context = this.context(command);
    if (context?.purpose === 'review') return;
    this.starting.set(command.clientMessageId, projectId);
    const id = hash(context?.attemptId || command.clientMessageId);
    const previous = await this.store(projectId, id).read();
    const record: ProjectRunChange = previous ?? { version: 1, id, projectId, partnerId: command.partnerId, attemptId: context?.attemptId, taskId: context?.taskId, roomId: command.route.scope === 'group' ? command.route.roomId : undefined, messageId: command.route.scope === 'group' ? command.clientMessageId : undefined, title: context?.title ?? '本次伙伴回复', runIds: [], status: 'recording', startedAt: new Date().toISOString(), files: [], commits: [], verification: [], complete: true, warnings: [] };
    if (previous?.status === 'recording') { record.complete = false; record.warnings.push('上次执行未完整结束'); }
    record.status = 'recording'; delete record.finishedAt;
    const warn = (message: string) => { record.complete = false; if (!record.warnings.includes(message)) record.warnings.push(message); };
    const root = await this.browser.root(projectId);
    let head: string | undefined; try { head = (await this.browser.git(root, ['rev-parse', '--verify', 'HEAD'])).toString().trim(); } catch { /* no commits */ }
    const baseline = await this.capture(projectId, root, warn);
    const concurrent = [...this.starting.values()].filter((value) => value === projectId).length > 1;
    for (const other of this.active.values()) if (other.record.projectId === projectId) { other.uncertain = true; other.record.complete = false; if (!other.record.warnings.includes('同项目存在并发执行，归属可能不完整')) other.record.warnings.push('同项目存在并发执行，归属可能不完整'); }
    if (concurrent) warn('同项目存在并发执行，归属可能不完整');
    this.active.set(command.clientMessageId, { record, root, baseline, head, known: new Set(), commands: [], tools: new Map(), uncertain: concurrent });
    await this.store(projectId, id).writeNow(record);
  }

  failedStart(command: SendMessageCommand) { this.starting.delete(command.clientMessageId); this.active.delete(command.clientMessageId); }
  report(command: SendMessageCommand, paths: string[], verification: Array<{ commandOrCheck: string; result: string }> = []) {
    const active = this.active.get(command.clientMessageId); if (!active) return;
    for (const value of paths) this.know(active, value);
    if (verification.some((item) => item.result !== 'not_run' && /test|测试|pytest|vitest/i.test(item.commandOrCheck))) active.record.reportedTests = true;
  }
  private know(active: ActiveChange, value: string) {
    const relative = path.isAbsolute(value) ? path.relative(active.root, value) : value;
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) active.known.add(relative.replaceAll('\\', '/'));
  }
  async observe(event: PartnerEvent, command: SendMessageCommand) {
    const active = this.active.get(command.clientMessageId); if (!active) return;
    if (!active.record.runIds.includes(event.runId)) active.record.runIds.push(event.runId);
    if (event.type === 'file.produced' && event.source?.kind === 'local_path') this.know(active, event.source.path);
    if (event.type === 'tool.started') {
      let detail: any; try { detail = JSON.parse(event.detail ?? '{}'); } catch { detail = {}; }
      const input = detail.input ?? detail;
      const paths = [input.path, input.file_path, input.filePath, ...(Array.isArray(detail.changes) ? detail.changes.map((item: any) => item.path) : [])].filter((value): value is string => typeof value === 'string');
      const rawCommand = input.cmd ?? input.command ?? detail.command;
      const text = Array.isArray(rawCommand) ? rawCommand.at(-1) : typeof rawCommand === 'string' ? rawCommand : '';
      if (isTestCommand(text)) active.record.testCommandObserved = true;
      active.tools.set(event.toolCallId, { name: event.toolName, detail: event.detail ?? '', command: text, paths, mutates: event.mutatesExternalState });
    }
    if (event.type === 'tool.completed') {
      const tool = active.tools.get(event.toolCallId);
      if (tool?.mutates && event.outcome === 'success' && tool.command) active.commands.push(tool.command);
      if (tool?.mutates && event.outcome === 'success') for (const value of tool.paths) this.know(active, value);
      if (tool && isTestCommand(tool.command) && /command|exec|bash|powershell|shell/i.test(tool.name)) active.record.verification.push({ command: tool.command.slice(0, 2000), result: event.outcome === 'success' ? 'passed' : 'failed', toolCallId: event.toolCallId });
    }
    if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) await this.finish(command, event.type === 'run.completed' ? 'completed' : event.type === 'run.cancelled' ? 'cancelled' : 'failed');
  }
  async finish(command: SendMessageCommand, status: ProjectRunChange['status']) {
    const active = this.active.get(command.clientMessageId); if (!active) return;
    const { record } = active;
    const warn = (message: string) => { record.complete = false; if (!record.warnings.includes(message)) record.warnings.push(message); };
    const after = await this.capture(record.projectId, active.root, warn);
    const changed = [...new Set([...Object.keys(active.baseline), ...Object.keys(after)])].filter((file) => active.baseline[file]?.hash !== after[file]?.hash);
    if (changed.length) record.observedChanges = true;
    for (const file of changed) {
      const variants = [file, file.replaceAll('/', '\\'), path.join(active.root, file)];
      const mentioned = active.commands.some((commandText) => /\b(?:Set-Content|Add-Content|Out-File|Move-Item|Remove-Item|Copy-Item|New-Item|apply_patch|writeFile|write_text)\b|(?:^|\s)>>?\s/i.test(commandText) && variants.some((variant) => commandText.includes(variant)));
      if (!active.known.has(file) && !mentioned) { warn('存在缺少执行证据的文件变化，未计入本次改动'); continue; }
      const prior = record.files.find((item) => item.path === file);
      const beforeBlob = prior ? prior.before : active.baseline[file]?.blob;
      const afterBlob = after[file]?.blob;
      const beforeBytes = await this.bytes(record.projectId, beforeBlob); const afterBytes = await this.bytes(record.projectId, afterBlob);
      const binary = beforeBytes?.includes(0) || afterBytes?.includes(0);
      const unavailable = Boolean((active.baseline[file] && !active.baseline[file].blob) || (after[file] && !after[file].blob) || binary);
      const diff = unavailable ? undefined : await this.blob(record.projectId, Buffer.from(unifiedRunDiff(file, beforeBytes?.toString('utf8') ?? '', afterBytes?.toString('utf8') ?? '')));
      const entry: ProjectRunChangedFile = { path: file, status: !active.baseline[file] && !prior?.before ? 'A' : !after[file] ? 'D' : 'M', before: beforeBlob, after: afterBlob, diff, unavailable };
      record.files = [...record.files.filter((item) => item.path !== file), entry];
    }
    let head: string | undefined; try { head = (await this.browser.git(active.root, ['rev-parse', '--verify', 'HEAD'])).toString().trim(); } catch { /* no Git */ }
    if (head && head !== active.head) {
      record.observedChanges = true;
      const committed = active.commands.some((text) => !/--dry-run/.test(text) && /(?:^|[;&\n])\s*git\s+(?:(?:-c|-C|--git-dir|--work-tree)\s+(?:'[^']*'|"[^"]*"|\S+)\s+|--\S+\s+)*commit(?:\s|$)/i.test(text));
      if (active.head) try { await this.browser.git(active.root, ['merge-base', '--is-ancestor', active.head, head]); } catch { warn('Git 分支发生切换，提交归属无法确认'); active.uncertain = true; }
      if (committed && !active.uncertain) {
        const shas = (await this.browser.git(active.root, ['rev-list', active.head ? `${active.head}..${head}` : head, '--', '.'])).toString().trim().split('\n').filter(Boolean);
        if (shas.length > 30) warn('本次提交过多，提交清单已截断');
        const history = await this.browser.query({ projectId: record.projectId, action: 'history' });
        record.commits = [...new Map([...record.commits, ...(history.commits ?? []).filter((item) => shas.includes(item.sha))].map((item) => [item.sha, item])).values()];
      } else warn('新增提交缺少本次执行的明确归属证据');
    }
    record.status = this.context(command)?.control === 'paused' ? 'paused' : status;
    record.finishedAt = new Date().toISOString();
    await this.store(record.projectId, record.id).writeNow(record);
    this.active.delete(command.clientMessageId); this.starting.delete(command.clientMessageId); this.publish(record.projectId);
  }
  async list(projectId: string) {
    await this.browser.root(projectId);
    const names = await readdir(this.projectDirectory(projectId)).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    const records = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => this.store(projectId, name.slice(0, -5)).read()));
    return records.filter((item): item is ProjectRunChange => Boolean(item)).map((item) => item.status === 'recording' ? { ...item, complete: false, warnings: [...item.warnings, '执行尚未结束或上次记录被中断'] } : item);
  }
  async read(request: ProjectRunChangeRead): Promise<ProjectPreviewContent> {
    await this.browser.root(request.projectId);
    const record = await this.store(request.projectId, request.id).read(); const file = record?.files.find((item) => item.path === request.path);
    if (!record || !file) throw new Error('PROJECT_CHANGE_FILE_NOT_FOUND');
    const bytes = await this.bytes(request.projectId, file.after);
    const diff = await this.bytes(request.projectId, file.diff);
    return { name: path.basename(file.path), path: file.path, info: { previewKind: 'text' }, ...(bytes ? decodeProjectContent(path.basename(file.path), file.path, bytes) : {}), diff: diff?.toString('utf8') ?? (file.unavailable ? '此文件超出文本快照范围或为二进制文件，无法显示文本差异。' : '该版本文件已删除。') };
  }
  async removeProject(projectId: string) {
    const target = this.projectDirectory(projectId); const root = path.resolve(this.directory());
    if (path.dirname(path.resolve(target)) !== root) throw new Error('PROJECT_CHANGE_ID_INVALID');
    await rm(target, { recursive: true, force: true });
  }
}

export function isTestCommand(value: string) {
  if (/[;&|`\r\n]/.test(value) || /--(?:listTests|collect-only|dry-run|no-run|help|version)\b/.test(value)) return false;
  return /^\s*(?:npm\s+(?:test|run\s+test[\w:-]*)|npx\s+vitest(?:\s+run)?|(?:python\s+-m\s+)?pytest|cargo\s+test|go\s+test|dotnet\s+test|node\s+["']?tests[\\/])(?:\s|$|[^\s]+\.mjs)/i.test(value);
}
export function unifiedRunDiff(file: string, before: string, after: string) {
  const left = before ? before.replace(/\n$/, '').split('\n') : []; const right = after ? after.replace(/\n$/, '').split('\n') : [];
  let prefix = 0; while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0; while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3); const tail = Math.min(3, suffix);
  const lines = [...left.slice(start, prefix).map((line) => ` ${line}`), ...left.slice(prefix, left.length - suffix).map((line) => `-${line}`), ...right.slice(prefix, right.length - suffix).map((line) => `+${line}`), ...left.slice(left.length - suffix, left.length - suffix + tail).map((line) => ` ${line}`)];
  return `--- ${before ? `a/${file}` : '/dev/null'}\n+++ ${after ? `b/${file}` : '/dev/null'}\n@@ -${left.length ? start + 1 : 0},${left.length - suffix + tail - start} +${right.length ? start + 1 : 0},${right.length - suffix + tail - start} @@\n${lines.join('\n')}\n`;
}
