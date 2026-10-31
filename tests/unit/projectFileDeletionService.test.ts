import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProjectFileDeletionService } from '../../src/main/project/ProjectFileDeletionService';
import { ProjectMutationCoordinator } from '../../src/main/project/ProjectMutationCoordinator';
import type { ArtifactDeletionSnapshot } from '../../src/main/security/ArtifactRegistry';
import type { ProjectFileRecordSnapshot } from '../../src/shared/projectWorkspace';

const targetRecord: ProjectFileRecordSnapshot = {
  version: 1,
  fileId: 'file-a',
  projectId: 'project-a',
  relativePath: 'result.md',
  category: 'delivery',
  revision: 1,
  contentHash: 'hash',
  sizeBytes: 6,
  modifiedAt: '2026-10-17T00:00:00.000Z',
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  artifactId: 'artifact-a',
};

function fixture(input: {
  available: boolean;
  referenced?: boolean;
  taskStatus?: 'todo' | 'in_progress' | 'blocked' | 'review' | 'completed' | 'cancelled';
  attemptStatus?: 'waiting_dependencies' | 'queued' | 'starting' | 'running' | 'pause_requested' | 'paused' | 'cancel_requested' | 'cancelled' | 'failed' | 'succeeded';
  downstream?: boolean;
  activeWorkflow?: boolean;
}) {
  const absolutePath = path.resolve('C:\\projects\\a\\result.md');
  const markRemoved = vi.fn(async () => ({ ...targetRecord, removedAt: '2026-10-17T01:00:00.000Z' }));
  const trashItem = vi.fn(async () => undefined);
  const files = {
    allSnapshots: vi.fn(async () => [targetRecord]),
    deletionSnapshot: vi.fn(async () => ({ record: targetRecord, absolutePath, available: input.available })),
    markRemoved,
    list: vi.fn(async () => []),
  };
  const artifacts = {
    allProjectDeliveries: vi.fn(async () => [{ artifactId: 'artifact-a', projectId: 'project-a', relativePath: 'result.md', contentHash: 'hash', sizeBytes: 6, savedAt: '2026-10-17T00:00:00.000Z' }]),
    allDeletionSnapshots: vi.fn<() => Promise<ArtifactDeletionSnapshot[]>>(async () => [{ id: 'artifact-a', name: 'result.md', sourceKind: 'local_path', sourcePath: absolutePath, availability: input.available ? 'available' : 'missing', projectDeliveries: [] }]),
    deletionSnapshot: vi.fn(async () => ({ id: 'artifact-a', name: 'result.md', sourceKind: 'local_path', sourcePath: absolutePath, availability: input.available ? 'available' : 'missing', projectDeliveries: [] })),
    markRemoved: vi.fn(async () => undefined),
  };
  const domain = {
    snapshot: vi.fn(async () => ({
      version: 1,
      projects: [{ id: 'project-a', name: '项目 A' }],
      tasks: [
        { id: 'task-a', projectId: 'project-a', code: 'TSK-001', title: '实现结果', status: input.taskStatus ?? 'completed', dependencyIds: [] },
        ...(input.downstream ? [{ id: 'task-b', projectId: 'project-a', code: 'TSK-002', title: '使用结果', status: 'todo', dependencyIds: ['task-a'] }] : []),
      ],
    })),
  };
  const executions = {
    snapshot: vi.fn(async () => ({
      version: 1,
      attempts: input.referenced ? [{
        id: 'attempt-a', projectId: 'project-a', taskId: 'task-a',
        status: input.attemptStatus ?? 'succeeded',
        handoff: { fileRefs: [{ fileId: 'file-a', relativePath: 'result.md', revision: 1, contentHash: 'hash', sizeBytes: 6 }] },
      }] : [],
      events: [],
    })),
  };
  const workflows = {
    listProject: vi.fn(async () => input.activeWorkflow ? [{
      id: 'workflow-a', projectId: 'project-a', status: 'active', activatedTasks: [{ draftNodeId: 'node-a', taskId: 'task-a' }],
    }] : []),
  };
  const workspaces = { get: vi.fn(async () => ({ rootPath: path.resolve('C:\\projects\\a') })) };
  const service = new ProjectFileDeletionService({
    files: files as never,
    artifacts: artifacts as never,
    workspaces: workspaces as never,
    domain: domain as never,
    executions: executions as never,
    workflows: workflows as never,
    coordinator: new ProjectMutationCoordinator(),
    trashItem,
  });
  return { service, files, artifacts, trashItem };
}

describe('ProjectFileDeletionService', () => {
  it('blocks an available project file when an unfinished task still references its stable fileId', async () => {
    const value = fixture({ available: true, referenced: true, taskStatus: 'review' });
    const inspection = await value.service.inspect({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' });
    expect(inspection).toMatchObject({ sourceState: 'available', action: 'trash_and_remove', canDelete: false, requiresConfirmation: true });
    expect(inspection.references).toContainEqual(expect.objectContaining({ kind: 'task', taskId: 'task-a', label: expect.stringContaining('TSK-001') }));
    await expect(value.service.delete({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' })).rejects.toThrow('FILE_DELETE_REFERENCED');
    expect(value.trashItem).not.toHaveBeenCalled();
    expect(value.files.markRemoved).not.toHaveBeenCalled();
  });

  it('moves an unreferenced available project file to the recycle bin before hiding its record', async () => {
    const value = fixture({ available: true });
    const result = await value.service.delete({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' });
    expect(value.trashItem).toHaveBeenCalledWith(path.resolve('C:\\projects\\a\\result.md'));
    expect(value.files.markRemoved).toHaveBeenCalledWith('project-a', 'file-a', expect.any(String));
    expect(result.projectSnapshots).toEqual([{ projectId: 'project-a', files: [] }]);
  });

  it('allows a missing file record to be hidden even when its broken runtime reference is retained', async () => {
    const value = fixture({ available: false, referenced: true, taskStatus: 'review' });
    const inspection = await value.service.inspect({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' });
    expect(inspection).toMatchObject({ sourceState: 'missing', action: 'remove_record', canDelete: true, requiresConfirmation: false });
    expect(inspection.references).toContainEqual(expect.objectContaining({ kind: 'task' }));
    await value.service.delete({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' });
    expect(value.trashItem).not.toHaveBeenCalled();
    expect(value.files.markRemoved).toHaveBeenCalled();
  });

  it('does not treat a project file record or completed task history as a deletion blocker', async () => {
    const value = fixture({ available: true, referenced: true, taskStatus: 'completed' });
    const inspection = await value.service.inspect({ kind: 'artifact', artifactId: 'artifact-a' });
    expect(inspection).toMatchObject({ canDelete: true, references: [] });
    await value.service.delete({ kind: 'artifact', artifactId: 'artifact-a' });
    expect(value.artifacts.markRemoved).toHaveBeenCalled();
  });

  it('does not treat another chat delivery record for the same path as a blocker', async () => {
    const value = fixture({ available: true });
    value.artifacts.allDeletionSnapshots.mockResolvedValue([
      { id: 'artifact-a', name: 'result.md', sourceKind: 'local_path', sourcePath: path.resolve('C:\\projects\\a\\result.md'), availability: 'available', projectDeliveries: [] },
      { id: 'artifact-b', name: '同一文件.md', sourceKind: 'local_path', sourcePath: path.resolve('C:\\projects\\a\\result.md'), availability: 'available', conversationId: 'conversation-b', projectDeliveries: [] },
    ]);
    const inspection = await value.service.inspect({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' });
    expect(inspection).toMatchObject({ canDelete: true, references: [] });
  });

  it('does not let a completed task handoff block deletion after the workflow has ended', async () => {
    const value = fixture({ available: true, referenced: true, taskStatus: 'completed' });
    const inspection = await value.service.inspect({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' });
    expect(inspection).toMatchObject({ canDelete: true, references: [] });
  });

  it('blocks a completed upstream handoff while an unfinished downstream task still depends on it', async () => {
    const value = fixture({ available: true, referenced: true, taskStatus: 'completed', downstream: true });
    const inspection = await value.service.inspect({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' });
    expect(inspection.canDelete).toBe(false);
    expect(inspection.references[0]?.label).toContain('后续节点依赖');
  });

  it('labels an unfinished task reference as part of an active workflow', async () => {
    const value = fixture({ available: true, referenced: true, taskStatus: 'review', activeWorkflow: true });
    const inspection = await value.service.inspect({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' });
    expect(inspection.canDelete).toBe(false);
    expect(inspection.references[0]?.label).toContain('活动流程');
  });

  it('does not let active workflow membership turn a completed terminal task into a blocker', async () => {
    const value = fixture({ available: true, referenced: true, taskStatus: 'completed', activeWorkflow: true });
    const inspection = await value.service.inspect({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' });
    expect(inspection).toMatchObject({ canDelete: true, references: [] });
  });

  it('ignores references that only exist in a failed historical attempt', async () => {
    const value = fixture({ available: true, referenced: true, taskStatus: 'todo', attemptStatus: 'failed' });
    const inspection = await value.service.inspect({ kind: 'project_file', projectId: 'project-a', fileId: 'file-a' });
    expect(inspection).toMatchObject({ canDelete: true, references: [] });
  });
});
