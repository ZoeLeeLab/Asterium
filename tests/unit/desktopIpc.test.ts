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
    const mainDirectory = path.join(process.cwd(), 'src', 'main');
    const [source, notebookSource, artifactSource, studioNoteSource, projectRoleSource, extensionsSource, projectRunChangesSource, projectFileQuerySource, desktopNavigationSource, appUpdateSource, projectWorkflowTemplateSource, generalSettingsSource, projectWorkflowQuerySource, webSearchCredentialSource, projectWorkspaceSource, apiCredentialSource, projectFileOpenSource, apiConnectionsSource, automationSource, studioRoomSource, partnerDiarySource, delegationSource, memoryImportSource, partnerWorkspaceSource, localRuntimeDetectionSource, codexRuntimeQuerySource, apiModelListSource, apiConnectionProbeSource, profileDirectorySource, userProfileSource, memoryFallbackModelListSource, memoryFallbackSettingsSource, sessionStatusSource, sessionMaintenanceSource, memoryArchiveSource, memoryBackupExportSource] = await Promise.all([
      readFile(path.join(mainDirectory, 'agentIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectNotebookIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'artifactIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'studioNoteIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectRoleIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'extensionsIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectRunChangesIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectFileQueryIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'desktopNavigationIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'appUpdateIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectWorkflowTemplateIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'generalSettingsIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectWorkflowQueryIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'webSearchCredentialIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectWorkspaceIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'apiCredentialIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'projectFileOpenIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'apiConnectionsIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'automationIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'studioRoomIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'partnerDiaryIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'delegationIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'memoryImportIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'partnerWorkspaceIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'localRuntimeDetectionIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'codexRuntimeQueryIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'apiModelListIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'apiConnectionProbeIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'profileDirectoryIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'userProfileIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'memoryFallbackModelListIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'memoryFallbackSettingsIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'sessionStatusIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'sessionMaintenanceIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'memoryArchiveIpc.ts'), 'utf8'),
      readFile(path.join(mainDirectory, 'ipc', 'memoryBackupExportIpc.ts'), 'utf8'),
    ]);
    const handledKeys = [source, notebookSource, artifactSource, studioNoteSource, projectRoleSource, extensionsSource, projectRunChangesSource, projectFileQuerySource, desktopNavigationSource, appUpdateSource, projectWorkflowTemplateSource, generalSettingsSource, projectWorkflowQuerySource, webSearchCredentialSource, projectWorkspaceSource, apiCredentialSource, projectFileOpenSource, apiConnectionsSource, automationSource, studioRoomSource, partnerDiarySource, delegationSource, memoryImportSource, partnerWorkspaceSource, localRuntimeDetectionSource, codexRuntimeQuerySource, apiModelListSource, apiConnectionProbeSource, profileDirectorySource, userProfileSource, memoryFallbackModelListSource, memoryFallbackSettingsSource, sessionStatusSource, sessionMaintenanceSource, memoryArchiveSource, memoryBackupExportSource].flatMap((moduleSource) =>
      [...moduleSource.matchAll(/ipcMain\.handle\(AGENT_IPC\.(\w+)/g)].map((match) => match[1] as keyof typeof DESKTOP_IPC));
    const handledChannels = handledKeys.map((key) => DESKTOP_IPC[key]);

    expect(new Set(handledChannels).size).toBe(handledChannels.length);
    expect([...handledChannels].sort()).toEqual([...DESKTOP_INVOKE_CHANNELS].sort());
    expect(source).toContain('for (const channel of DESKTOP_INVOKE_CHANNELS) ipcMain.removeHandler(channel);');
  });
});
