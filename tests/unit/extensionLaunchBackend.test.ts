// @vitest-environment node
import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NativeExtensionLaunchBackend } from '../../src/main/api/extensions/ExtensionLaunchBackend';

describe('replaceable extension launch backend', () => {
  it('provides a native script process with explicit cwd/environment and closes it on cancellation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-s3-script-'));
    const marker = path.join(dir, 'script-result.json');
    const backend = new NativeExtensionLaunchBackend(); const abort = new AbortController();
    const original = process.env.ASTERIUM_PRIVATE_CANARY; process.env.ASTERIUM_PRIVATE_CANARY = 'never-inherit';
    let script: Awaited<ReturnType<typeof backend.launchSkillScript>> | undefined;
    try {
      script = await backend.launchSkillScript({
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({cwd:process.cwd(),value:process.env.EXPLICIT_VALUE,private:process.env.ASTERIUM_PRIVATE_CANARY}));setInterval(()=>{},1000)`],
        cwd: dir, env: { EXPLICIT_VALUE: 'script-fixture' }, signal: abort.signal,
      });
      await vi.waitFor(async () => expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ cwd: dir, value: 'script-fixture' }));
      expect(backend.id).toBe('native'); expect(backend.sandboxed).toBe(false);
      abort.abort(); await vi.waitFor(() => expect(script!.process.exitCode !== null || script!.process.signalCode !== null).toBe(true));
    } finally {
      if (original === undefined) delete process.env.ASTERIUM_PRIVATE_CANARY; else process.env.ASTERIUM_PRIVATE_CANARY = original;
      await script?.close();
      const target = await realpath(dir); expect(path.dirname(target).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase());
      expect(path.basename(target).startsWith('asterium-s3-script-')).toBe(true);
      await rm(target, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('refuses an already cancelled script before creating a process', async () => {
    const backend = new NativeExtensionLaunchBackend(); const abort = new AbortController(); abort.abort();
    await expect(backend.launchSkillScript({ command: 'must-never-run', args: [], cwd: os.tmpdir(), env: {}, signal: abort.signal })).rejects.toThrow();
  });
});
