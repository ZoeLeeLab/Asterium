import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_INVOKE_CHANNELS, DESKTOP_IPC, DESKTOP_PUSH_CHANNELS, DESKTOP_SEND_CHANNELS } from '../../src/shared/desktopIpc';

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

  it('classifies every main-process handler for shared disposer cleanup', async () => {
    const source = await readFile(path.join(process.cwd(), 'src', 'main', 'agentIpc.ts'), 'utf8');
    const handledKeys = [...source.matchAll(/ipcMain\.handle\(AGENT_IPC\.(\w+)/g)].map((match) => match[1] as keyof typeof DESKTOP_IPC);
    const handledChannels = handledKeys.map((key) => DESKTOP_IPC[key]);

    expect(new Set(handledChannels).size).toBe(handledChannels.length);
    expect([...handledChannels].sort()).toEqual([...DESKTOP_INVOKE_CHANNELS].sort());
    expect(source).toContain('for (const channel of DESKTOP_INVOKE_CHANNELS) ipcMain.removeHandler(channel);');
  });
});
