// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';

vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), stat: vi.fn((await original<typeof import('node:fs/promises')>()).stat) }));

let directory: string;
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'asterium-command-contract-')));
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
});
afterEach(async () => { vi.useRealTimers(); vi.clearAllMocks(); await rm(directory, { recursive: true, force: true }); });

async function start(command = 'Write-Output fixture', controller = new AbortController()) {
  const launches = vi.mocked(spawn).mock.calls.length;
  const pending = new ApiAgentTools(directory).execute('run_command', { command }, controller.signal);
  // Attach rejection handling before driving cancellation or timers.
  void pending.catch(() => undefined);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(launches + 1));
  return { pending };
}

describe('ordinary command compatibility contract', () => {
  it('keeps interpreter flags, inherited environment, hidden window and combined output', async () => {
    const { pending } = await start();
    expect(spawn).toHaveBeenCalledExactlyOnceWith(process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output fixture'], { cwd: directory, windowsHide: true });
    child.stdout.emit('data', Buffer.from('stdout\n')); child.stderr.emit('data', Buffer.from('stderr'));
    child.emit('close', 0);
    expect(await pending).toEqual({ content: 'stdout\nstderr' });
  });

  it('retains nonzero exit and empty-success formatting', async () => {
    const failed = await start(); child.stderr.emit('data', Buffer.from('fixture failure')); child.emit('close', 7);
    await expect(failed.pending).rejects.toThrow('TOOL_COMMAND_FAILED:7:fixture failure');
    const success = await start(); child.emit('close', 0);
    expect(await success.pending).toEqual({ content: '(exit 0)' });
  });

  it('keeps the 120 second deadline and timeout error', async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const { pending } = await start();
    expect(timers).toHaveBeenCalledWith(expect.any(Function), 120_000);
    await vi.advanceTimersByTimeAsync(119_000); expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000); expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null); await expect(pending).rejects.toThrow('TOOL_COMMAND_TIMEOUT');
  });

  it('refuses cancellation before preparation without launching', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(new ApiAgentTools(directory).execute('run_command', { command: 'fixture' }, controller.signal)).rejects.toThrow('ABORTED');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not launch when cancellation occurs during the asynchronous cwd check', async () => {
    const controller = new AbortController();
    vi.mocked(stat).mockImplementationOnce(async () => { controller.abort(); return { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>; });
    await expect(new ApiAgentTools(directory).execute('run_command', { command: 'fixture' }, controller.signal)).rejects.toThrow('ABORTED');
    expect(controller.signal.aborted).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('still stops an already launched command on cancellation', async () => {
    const controller = new AbortController();
    const { pending } = await start('fixture', controller);
    controller.abort(); expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null); await expect(pending).rejects.toThrow('ABORTED');
  });
});
