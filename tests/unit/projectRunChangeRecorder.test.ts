import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { PartnerEvent, SendMessageCommand } from '../../src/shared/agentProtocol';
import { ProjectBrowserService } from '../../src/main/project/ProjectBrowserService';
import { isTestCommand, ProjectRunChangeRecorder, unifiedRunDiff } from '../../src/main/project/ProjectRunChangeRecorder';
const temporary: string[] = []; const exec = promisify(execFile);
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-changes-')); temporary.push(root);
  const project = path.join(root, '项目'); await mkdir(project);
  const browser = new ProjectBrowserService({ get: async () => ({ rootPath: project }) } as never, {} as never);
  const context = { attemptId: 'attempt-1', taskId: 'task-1', title: '登录页', control: undefined as string | undefined };
  const make = () => new ProjectRunChangeRecorder(() => path.join(root, 'records'), browser, async () => 'p', () => context);
  const command = { clientMessageId: 'message-1', partnerId: 'partner-1', route: { scope: 'workspace', projectId: 'p' } } as SendMessageCommand;
  const event = (value: object) => ({ runId: 'run-1', ...value }) as PartnerEvent;
  const git = (args: string[]) => exec('git', ['-c', `safe.directory=${project}`, '-C', project, ...args], { windowsHide: true });
  return { root, project, browser, context, make, command, event, git };
}
describe('frozen project run changes', () => {
  it('isolates baseline dirty files and freezes exact before/after content across restart', async () => {
    const f = await fixture(); const recorder = f.make();
    await writeFile(path.join(f.project, 'a.ts'), 'already dirty\n'); await writeFile(path.join(f.project, 'unrelated.ts'), 'old dirty\n');
    await recorder.begin(f.command); recorder.report(f.command, ['a.ts']);
    await writeFile(path.join(f.project, 'a.ts'), 'task new\n');
    await recorder.observe(f.event({ type: 'run.completed' }), f.command);
    const [record] = await recorder.list('p'); expect(record.files.map((file) => file.path)).toEqual(['a.ts']); expect(record.complete).toBe(true);
    await writeFile(path.join(f.project, 'a.ts'), 'next task\n');
    const content = await f.make().read({ projectId: 'p', id: record.id, path: 'a.ts' });
    expect(content.text).toBe('task new\n'); expect(content.diff).toContain('-already dirty'); expect(content.diff).not.toContain('next task');
  });
  it('keeps external unexplained changes out and marks incomplete rather than attributing them', async () => {
    const f = await fixture(); const recorder = f.make(); await recorder.begin(f.command);
    recorder.report(f.command, ['own.ts']); await writeFile(path.join(f.project, 'own.ts'), 'own'); await writeFile(path.join(f.project, 'external.ts'), 'external');
    await recorder.finish(f.command, 'completed'); const [record] = await recorder.list('p');
    expect(record.files.map((file) => file.path)).toEqual(['own.ts']); expect(record.complete).toBe(false);
  });
  it('captures a committed change even when Git is clean at the end', async () => {
    const f = await fixture(); const recorder = f.make();
    await f.git(['init']); await f.git(['config', 'user.name', 'Changes']); await f.git(['config', 'user.email', 'changes@example.invalid']);
    await writeFile(path.join(f.project, 'a.ts'), 'base\n'); await f.git(['add', '.']); await f.git(['commit', '-m', 'base']);
    await recorder.begin(f.command); recorder.report(f.command, ['a.ts']); await writeFile(path.join(f.project, 'a.ts'), 'new\n');
    await recorder.observe(f.event({ type: 'tool.started', toolCallId: 'commit', toolName: 'run_command', mutatesExternalState: true, detail: JSON.stringify({ command: 'git -c safe.directory="project" commit -am feature' }) }), f.command);
    await recorder.observe(f.event({ type: 'tool.completed', toolCallId: 'commit', outcome: 'success' }), f.command);
    await f.git(['commit', '-am', 'feature']); await recorder.finish(f.command, 'completed');
    const [record] = await recorder.list('p'); expect(record.files).toHaveLength(1); expect(record.commits).toHaveLength(1); expect(record.commits[0].subject).toBe('feature');
  });
  it('uses observed standalone test command results, not prose or build commands', async () => {
    const f = await fixture(); const recorder = f.make(); await recorder.begin(f.command);
    for (const [id, command] of [['build', 'npm run build'], ['test', 'npm test -- --run'], ['fake', 'echo npm test; exit 0']]) {
      await recorder.observe(f.event({ type: 'tool.started', toolCallId: id, toolName: 'run_command', detail: JSON.stringify({ command }) }), f.command);
      await recorder.observe(f.event({ type: 'tool.completed', toolCallId: id, outcome: 'success' }), f.command);
    }
    await recorder.finish(f.command, 'completed'); const [record] = await recorder.list('p');
    expect(record.verification).toEqual([{ command: 'npm test -- --run', result: 'passed', toolCallId: 'test' }]);
    expect(isTestCommand('npm run lint')).toBe(false); expect(isTestCommand('npm test | echo success')).toBe(false);
    expect(isTestCommand('pytest --collect-only')).toBe(false); expect(isTestCommand('cargo test --no-run')).toBe(false);
  });
  it('does not treat an ordinary read as evidence that the agent wrote a file', async () => {
    const f = await fixture(); const recorder = f.make(); await writeFile(path.join(f.project, 'a.ts'), 'original');
    await recorder.begin(f.command);
    await recorder.observe(f.event({ type: 'tool.started', toolCallId: 'read', toolName: 'read_file', mutatesExternalState: false, detail: JSON.stringify({ path: 'a.ts' }) }), f.command);
    await recorder.observe(f.event({ type: 'tool.completed', toolCallId: 'read', outcome: 'success' }), f.command);
    await writeFile(path.join(f.project, 'a.ts'), 'external modification'); await recorder.finish(f.command, 'completed');
    const [record] = await recorder.list('p'); expect(record.files).toHaveLength(0); expect(record.complete).toBe(false); expect(record.observedChanges).toBe(true);
  });
  it('merges paused segments of one attempt but keeps retries independent', async () => {
    const f = await fixture(); const recorder = f.make(); await writeFile(path.join(f.project, 'a.ts'), 'zero\n');
    await recorder.begin(f.command); recorder.report(f.command, ['a.ts']); await writeFile(path.join(f.project, 'a.ts'), 'one\n');
    f.context.control = 'paused'; await recorder.finish(f.command, 'cancelled');
    f.context.control = undefined; await recorder.begin(f.command); recorder.report(f.command, ['a.ts']); await writeFile(path.join(f.project, 'a.ts'), 'two\n'); await recorder.finish(f.command, 'completed');
    const [record] = await recorder.list('p'); const content = await recorder.read({ projectId: 'p', id: record.id, path: 'a.ts' }); expect(content.diff).toContain('-zero'); expect(content.diff).toContain('+two');
    f.context.attemptId = 'retry-2'; await recorder.begin(f.command); await recorder.finish(f.command, 'completed'); expect(await recorder.list('p')).toHaveLength(2);
  });
  it('marks overlapping runs incomplete and validates snapshot access', async () => {
    const f = await fixture(); const recorder = f.make();
    const other = { ...f.command, clientMessageId: 'other' }; f.context.attemptId = '';
    await Promise.all([recorder.begin(f.command), recorder.begin(other)]); await recorder.finish(f.command, 'completed'); await recorder.finish(other, 'completed');
    expect((await recorder.list('p')).every((record) => !record.complete)).toBe(true);
    await expect(recorder.read({ projectId: 'p', id: '../escape', path: 'file' })).rejects.toThrow('PROJECT_CHANGE_ID_INVALID');
    await expect(recorder.removeProject('../escape')).rejects.toThrow('PROJECT_CHANGE_ID_INVALID');
    expect(unifiedRunDiff('a.ts', 'a\nb\n', 'a\nc\n')).toContain('-b\n+c');
    await recorder.removeProject('p'); expect(await recorder.list('p')).toHaveLength(0);
    expect(await readFile(path.join(f.project, 'a.ts')).catch(() => 'missing')).toBe('missing');
  });
});
