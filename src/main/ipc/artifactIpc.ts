import { copyFile } from 'node:fs/promises';
import { clipboard, dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectFilesSnapshot } from '../../shared/projectWorkspace';
import type { ProjectFileDeletionService } from '../project/ProjectFileDeletionService';
import type { ProjectFileDeliveryCoordinator } from '../project/ProjectFileDeliveryCoordinator';
import { createArtifactBrowserLink } from '../security/ArtifactBrowserLink';
import type { ArtifactRegistry } from '../security/ArtifactRegistry';

interface ArtifactIpcDependencies {
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow;
  artifacts: ArtifactRegistry;
  saveArtifactToProject: (artifactId: string, projectId: string) => ReturnType<ProjectFileDeliveryCoordinator['deliver']>;
  projectFileDeletions: Pick<ProjectFileDeletionService, 'inspect' | 'delete'>;
  publishProjectFiles: (snapshot: ProjectFilesSnapshot) => void;
}

export function registerArtifactIpc(ipcMain: Pick<IpcMain, 'handle'>, {
  requireSender, artifacts, saveArtifactToProject, projectFileDeletions, publishProjectFiles,
}: ArtifactIpcDependencies) {
  ipcMain.handle(AGENT_IPC.artifactListLatestConversation, async (event, conversationId: unknown) => {
    requireSender(event);
    if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 512) throw new Error('INVALID_ARTIFACT_CONVERSATION');
    return artifacts.listLatestConversation(conversationId);
  });

  ipcMain.handle(AGENT_IPC.artifactInspect, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    return (await artifacts.inspectIfRegistered(artifactId)) ?? null;
  });

  ipcMain.handle(AGENT_IPC.artifactResolveConversationLink, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.conversationId !== 'string' || !value.conversationId.trim()
      || value.conversationId.length > 512 || typeof value.href !== 'string') throw new Error('INVALID_ARTIFACT_LINK');
    return (await artifacts.resolveConversationLink(value.conversationId, value.href)) ?? null;
  });
  ipcMain.handle(AGENT_IPC.artifactRead, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    return artifacts.read(artifactId);
  });
  ipcMain.handle(AGENT_IPC.artifactOpen, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    const error = await shell.openPath(await artifacts.pathFor(artifactId));
    if (error) throw new Error(error);
  });
  ipcMain.handle(AGENT_IPC.artifactOpenInBrowser, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    const path = await artifacts.pathFor(artifactId);
    const { name, mediaType } = await artifacts.inspect(artifactId);
    const link = await createArtifactBrowserLink({ path, name, mediaType });
    try {
      await shell.openExternal(link.url);
    } catch (error) {
      link.close();
      throw error;
    }
  });
  ipcMain.handle(AGENT_IPC.artifactReveal, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    shell.showItemInFolder(await artifacts.pathFor(artifactId));
  });
  ipcMain.handle(AGENT_IPC.artifactCopyPath, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    const originalPath = await artifacts.originalPathFor(artifactId);
    if (!originalPath) throw new Error('ARTIFACT_HAS_NO_ORIGINAL_PATH');
    clipboard.writeText(originalPath);
  });
  ipcMain.handle(AGENT_IPC.artifactSaveAs, async (event, artifactId: unknown) => {
    const window = requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    const info = await artifacts.inspect(artifactId);
    const source = await artifacts.pathFor(artifactId);
    const result = await dialog.showSaveDialog(window, { defaultPath: info.name });
    if (result.canceled || !result.filePath) return false;
    await copyFile(source, result.filePath);
    return true;
  });
  ipcMain.handle(AGENT_IPC.artifactSaveToProject, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.artifactId !== 'string' || typeof value.projectId !== 'string' || !value.projectId.trim()) throw new Error('INVALID_PROJECT_ARTIFACT_REQUEST');
    return saveArtifactToProject(value.artifactId, value.projectId.trim());
  });
  ipcMain.handle(AGENT_IPC.artifactInspectDeletion, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    return projectFileDeletions.inspect({ kind: 'artifact', artifactId });
  });
  ipcMain.handle(AGENT_IPC.artifactDelete, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    const result = await projectFileDeletions.delete({ kind: 'artifact', artifactId });
    for (const snapshot of result.projectSnapshots) publishProjectFiles(snapshot);
    return result;
  });
  ipcMain.handle(AGENT_IPC.artifactCacheStats, async (event) => {
    requireSender(event);
    return artifacts.cacheStats();
  });
  ipcMain.handle(AGENT_IPC.artifactClearCache, async (event) => {
    requireSender(event);
    return artifacts.clearCache();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
