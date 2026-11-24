import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_INVOKE_CHANNELS, DESKTOP_IPC, DESKTOP_PUSH_CHANNELS, DESKTOP_SEND_CHANNELS } from '../../src/shared/desktopIpc';

async function handlerSources() {
  const directory = path.join(process.cwd(), 'src/main');
  const modules = (await readdir(path.join(directory, 'ipc'))).filter(name => name.endsWith('Ipc.ts')).sort();
  return await Promise.all(['agentIpc.ts', ...modules.map(name => 'ipc/' + name)].map(async file => ({
    file: path.basename(file),
    source: await readFile(path.join(directory, file), 'utf8'),
  })));
}

const handledKeys = (source: string) => [...source.matchAll(/ipcMain\.handle\(AGENT_IPC\.(\w+)/g)]
  .map(match => match[1] as keyof typeof DESKTOP_IPC);

describe('desktop IPC contract', () => {
  it('keeps every channel value unique and assigned to exactly one transport direction', () => {
    const all = Object.values(DESKTOP_IPC);
    const classified = [...DESKTOP_INVOKE_CHANNELS, ...DESKTOP_PUSH_CHANNELS, ...DESKTOP_SEND_CHANNELS];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...all].sort());
  });

  it('preserves the established channel strings at the compatibility boundaries', () => {
    expect(DESKTOP_IPC.titlebarTheme).toBe('asterium:titlebar-theme');
    expect(DESKTOP_IPC.sendMessage).toBe('asterium:agent:send-message');
    expect(DESKTOP_IPC.saveWebSearchCredential).toBe('asterium:agent:save-web-search-credential');
    expect(DESKTOP_IPC.deleteWebSearchCredential).toBe('asterium:agent:delete-web-search-credential');
    expect(DESKTOP_IPC.studioStartRound).toBe('asterium:studio:start-round');
    expect(DESKTOP_IPC.nativeSyncSingleBindings).toBe('asterium:native-bindings:sync-single');
    expect(DESKTOP_IPC.event).toBe('asterium:agent:event');
  });

  it('preserves all 97 planned ownership rows and verifies each current registration location', async () => {
    const [sources, plan] = await Promise.all([
      handlerSources(), readFile(path.join(process.cwd(), 'docs/ipc-domain-consolidation.md'), 'utf8'),
    ]);
    const rows = [...plan.matchAll(/^\| `(\w+)` \| `([^`]+)` \| `(\w+Ipc\.ts)` \| `(\w+Ipc\.ts)` \|$/gm)];
    expect(rows).toHaveLength(97);
    expect(new Set(rows.map(row => row[1])).size).toBe(97);
    for (const [, key, channel, finalModule, currentModule] of rows) {
      expect(channel).toBe(DESKTOP_IPC[key as keyof typeof DESKTOP_IPC]);
      expect(['agentIpc.ts', finalModule]).toContain(currentModule);
      expect(sources.flatMap(({ file, source }) => handledKeys(source).filter(item => item === key).map(() => file)))
        .toEqual([currentModule]);
    }
    expect(handledKeys(sources[0].source)).toEqual(rows.filter(row => row[4] === 'agentIpc.ts').map(row => row[1]));
  });

  it('classifies every main-process handler for shared disposer cleanup', async () => {
    const sources = await handlerSources();
    const channels = sources.flatMap(({ source }) => handledKeys(source).map(key => DESKTOP_IPC[key]));
    expect(channels).toHaveLength(230);
    expect(new Set(channels).size).toBe(channels.length);
    expect([...channels].sort()).toEqual([...DESKTOP_INVOKE_CHANNELS].sort());
    expect(sources[0].source).toContain('for (const channel of DESKTOP_INVOKE_CHANNELS) ipcMain.removeHandler(channel);');
  });

  it('keeps Wake in one domain module at its original registration and shutdown positions', async () => {
    const sources = await handlerSources();
    const main = sources[0].source;
    expect(handledKeys(sources.find(item => item.file === 'studioWakeIpc.ts')!.source))
      .toEqual(['studioWakeStatus', 'studioWakeConfigure', 'studioWakeControl']);
    expect(main).toMatch(/registerStudioRoundCancellationIpc\([^;]+;\s+registerStudioWakeIpc\(ipcMain, studioWakeControl, requireSender\);\s+registerStudioMcpHostIpc\(/);
    expect(main).toMatch(/await studioWakeControl\.dispose\(\);\s+await studioMcpStartup;\s+await studioMcpHost\.dispose\(\);\s+await studioWakeEvents\.dispose\(\);/);
  });
});
