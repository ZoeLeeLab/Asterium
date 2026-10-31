import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NativeThreadBinding, StudioRoomSnapshot } from '../../shared/studioRuntime';
import type { StudioNote } from '../../shared/studioNotes';
import type { ProjectWorkspaceSnapshot } from '../../shared/projectWorkspace';
import type { ProjectExecutionPolicy } from '../../shared/projectExecutionPolicy';
import type { ProjectRecord, ProjectTask } from '../../shared/projectDomain';
import type { ProjectWorkRoleDefinition } from '../../shared/projectRoles';
import type { ProjectWorkflow, ProjectWorkflowTemplate } from '../../shared/projectWorkflows';
import type { ProjectTaskExecutionProjectSnapshot } from '../../shared/projectTaskExecution';
import type { ArtifactProjectDelivery } from '../security/ArtifactRegistry';
import type { ProjectFileRecordSnapshot } from '../../shared/projectWorkspace';
import type { ProjectNotebook } from '../../shared/projectNotebook';

export interface ProjectCreateTransaction {
  transactionId: string;
  kind: 'project_create';
  projectId: string;
  createdAt: string;
}

export interface ProjectDeleteTransaction {
  transactionId: string;
  kind: 'project_delete';
  projectId: string;
  rooms: StudioRoomSnapshot[];
  notes: StudioNote[];
  workspace?: ProjectWorkspaceSnapshot;
  executionPolicy?: ProjectExecutionPolicy;
  project?: ProjectRecord;
  tasks?: ProjectTask[];
  projectRoles?: ProjectWorkRoleDefinition[];
  projectWorkflows?: ProjectWorkflow[];
  projectWorkflowTemplates?: ProjectWorkflowTemplate[];
  taskExecution?: ProjectTaskExecutionProjectSnapshot;
  partnerIds: string[];
  bindings: NativeThreadBinding[];
  deliveries: ArtifactProjectDelivery[];
  projectFiles?: ProjectFileRecordSnapshot[];
  projectNotebooks?: ProjectNotebook[];
  createdAt: string;
}

export interface ProjectWorkflowActivationTransaction {
  transactionId: string;
  kind: 'workflow_activation';
  projectId: string;
  workflow: ProjectWorkflow;
  project: ProjectRecord;
  tasks: ProjectTask[];
  taskExecution: ProjectTaskExecutionProjectSnapshot;
  activationId: string;
  createdAt: string;
}

export interface ProjectMembershipTransaction {
  /** Optional for transactions created before generation-isolated group sessions. */
  bindings?: NativeThreadBinding[];
  transactionId: string;
  kind: 'project_membership';
  projectId: string;
  rooms: StudioRoomSnapshot[];
  partnerIds: string[];
  rootPath?: string;
  project?: ProjectRecord;
  tasks?: ProjectTask[];
  projectNotebooks?: ProjectNotebook[];
  createdAt: string;
}

export type ProjectTransaction = ProjectCreateTransaction | ProjectDeleteTransaction | ProjectMembershipTransaction | ProjectWorkflowActivationTransaction;

interface ProjectTransactionFile {
  version: 1;
  pending?: ProjectTransaction;
}

export class ProjectTransactionStore {
  constructor(private readonly filePath: string | (() => string)) {}

  async get() {
    return (await this.read()).pending;
  }

  async begin(value: Omit<ProjectDeleteTransaction, 'transactionId' | 'createdAt'>): Promise<ProjectDeleteTransaction>;
  async begin(value: Omit<ProjectMembershipTransaction, 'transactionId' | 'createdAt'>): Promise<ProjectMembershipTransaction>;
  async begin(value: Omit<ProjectCreateTransaction, 'transactionId' | 'createdAt'>): Promise<ProjectCreateTransaction>;
  async begin(value: Omit<ProjectWorkflowActivationTransaction, 'transactionId' | 'createdAt'>): Promise<ProjectWorkflowActivationTransaction>;
  async begin(value: Omit<ProjectCreateTransaction, 'transactionId' | 'createdAt'> | Omit<ProjectDeleteTransaction, 'transactionId' | 'createdAt'> | Omit<ProjectMembershipTransaction, 'transactionId' | 'createdAt'> | Omit<ProjectWorkflowActivationTransaction, 'transactionId' | 'createdAt'>) {
    const current = await this.read();
    if (current.pending) throw new Error('PROJECT_TRANSACTION_ALREADY_PENDING');
    const pending = { ...structuredClone(value), transactionId: randomUUID(), createdAt: new Date().toISOString() } as ProjectTransaction;
    await this.write({ version: 1, pending });
    return pending;
  }

  async clear(transactionId: string) {
    const current = await this.read();
    if (!current.pending || current.pending.transactionId !== transactionId) return;
    await this.write({ version: 1 });
  }

  private resolvedPath() {
    return typeof this.filePath === 'function' ? this.filePath() : this.filePath;
  }

  private async read(): Promise<ProjectTransactionFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.resolvedPath(), 'utf8'));
      if (!isRecord(value) || value.version !== 1 || (value.pending !== undefined && !isRecord(value.pending))) throw new Error('PROJECT_TRANSACTION_STORE_INVALID');
      const file = value as unknown as ProjectTransactionFile;
      if (file.pending?.kind === 'project_delete' && !Array.isArray(file.pending.deliveries)) file.pending.deliveries = [];
      if (file.pending?.kind === 'project_delete' && !Array.isArray(file.pending.projectRoles)) file.pending.projectRoles = [];
      if (file.pending?.kind === 'project_delete' && !Array.isArray(file.pending.projectWorkflows)) file.pending.projectWorkflows = [];
      if (file.pending?.kind === 'project_delete' && !Array.isArray(file.pending.projectWorkflowTemplates)) file.pending.projectWorkflowTemplates = [];
      return file;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { version: 1 };
      throw error;
    }
  }

  private async write(value: ProjectTransactionFile) {
    const target = this.resolvedPath();
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
