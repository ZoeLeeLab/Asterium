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

  it('assigns every deferred handler to one final business module with its unchanged channel string', async () => {
    const [source, plan] = await Promise.all([
      readFile(path.join(process.cwd(), 'src/main/agentIpc.ts'), 'utf8'),
      readFile(path.join(process.cwd(), 'docs/ipc-domain-consolidation.md'), 'utf8'),
    ]);
    const rows = [...plan.matchAll(/^\| `(\w+)` \| `([^`]+)` \| `(\w+Ipc\.ts)` \|$/gm)];
    const handledKeys = [...source.matchAll(/ipcMain\.handle\(AGENT_IPC\.(\w+)/g)].map(match => match[1]);
    expect(rows).toHaveLength(97);
    expect(new Set(rows.map(row => row[1])).size).toBe(97);
    expect(rows.map(row => row[1])).toEqual(handledKeys);
    for (const [, key, channel] of rows) {
      expect(channel).toBe(DESKTOP_IPC[key as keyof typeof DESKTOP_IPC]);
    }
  });

  it('classifies every main-process handler for shared disposer cleanup', async () => {
    const mainDirectory = path.join(process.cwd(), 'src', 'main');
    const [source, notebookSource, artifactSource, studioNoteSource, projectRoleSource, projectTaskSource, extensionsSource, projectRunChangesSource, desktopNavigationSource, appUpdateSource, generalSettingsSource, projectWorkflowQuerySource, webSearchCredentialSource, projectWorkspaceSource, apiCredentialSource, projectFileOpenSource, apiConnectionsSource, automationSource, studioRoomSource, studioMcpHostSource, studioMcpCredentialSource, partnerDiarySource, delegationSource, memoryImportSource, partnerWorkspaceSource, workspaceGrantSource, claudeSessionImportSource, localRuntimeDetectionSource, codexRuntimeQuerySource, apiModelListSource, apiConnectionProbeSource, partnerProfileRefreshSource, memoryFallbackModelListSource, sessionStatusSource, runInteractionSource, memoryArchiveSource, memoryBackupExportSource, memoryBackupImportSource] = await Promise.all([
      readFile(path.join(mainDirectory, 'agentIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectNotebookIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'artifactIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'studioNoteIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectRoleIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectTaskIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'extensionsIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectRunChangesIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'desktopNavigationIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'appUpdateIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'generalSettingsIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectWorkflowIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'webSearchCredentialIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectWorkspaceIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'apiCredentialIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectFilesIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'apiConnectionsIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'automationIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'studioRoomIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'studioMcpHostIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'studioMcpCredentialIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'partnerDiaryIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'delegationIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'memoryImportIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'partnerWorkspaceIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'workspaceGrantIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'claudeSessionImportIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'localRuntimeDetectionIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'codexRuntimeQueryIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'apiModelListIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'apiConnectionProbeIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'profileIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'memoryFallbackIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'sessionIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'runInteractionIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'memoryArchiveIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'memoryBackupExportIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'memoryBackupImportIpc.ts'), 'utf8'),
    ]);
    const handledKeys = [source, notebookSource, artifactSource, studioNoteSource, projectRoleSource, projectTaskSource, extensionsSource, projectRunChangesSource, desktopNavigationSource, appUpdateSource, generalSettingsSource, projectWorkflowQuerySource, webSearchCredentialSource, projectWorkspaceSource, apiCredentialSource, projectFileOpenSource, apiConnectionsSource, automationSource, studioRoomSource, studioMcpHostSource, studioMcpCredentialSource, partnerDiarySource, delegationSource, memoryImportSource, partnerWorkspaceSource, workspaceGrantSource, claudeSessionImportSource, localRuntimeDetectionSource, codexRuntimeQuerySource, apiModelListSource, apiConnectionProbeSource, partnerProfileRefreshSource, memoryFallbackModelListSource, sessionStatusSource, runInteractionSource, memoryArchiveSource, memoryBackupExportSource, memoryBackupImportSource].flatMap((moduleSource) =>
      [...moduleSource.matchAll(/ipcMain\.handle\(AGENT_IPC\.(\w+)/g)].map((match) => match[1] as keyof typeof DESKTOP_IPC));
    const handledChannels = handledKeys.map((key) => DESKTOP_IPC[key]);

    expect(new Set(handledChannels).size).toBe(handledChannels.length);
    expect([...handledChannels].sort()).toEqual([...DESKTOP_INVOKE_CHANNELS].sort());
    expect(source).toContain('for (const channel of DESKTOP_INVOKE_CHANNELS) ipcMain.removeHandler(channel);');
  });
});
