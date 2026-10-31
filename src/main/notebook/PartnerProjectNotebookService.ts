import type { ProjectNotebook } from '../../shared/projectNotebook';
import type { ProjectDomainStore } from '../project/ProjectDomainStore';
import type { PartnerProfileStore } from '../partner/PartnerProfileStore';
import { PartnerProjectNotebookStore } from './PartnerProjectNotebookStore';

export class PartnerProjectNotebookService {
  private readonly stores = new Map<string, Promise<PartnerProjectNotebookStore>>();

  constructor(
    private readonly profiles: Pick<PartnerProfileStore, 'partnerIds' | 'workMemoryDirectory'>,
    private readonly domain: Pick<ProjectDomainStore, 'getProject' | 'snapshot'>,
  ) {}

  async snapshotProject(projectId: string) {
    const notebooks: ProjectNotebook[] = [];
    for (const partnerId of await this.profiles.partnerIds()) {
      const notebook = await (await this.store(partnerId)).get(projectId, { includeInactive: true, includeArchived: true });
      if (notebook) notebooks.push(notebook);
    }
    return notebooks;
  }

  async applyProjectMembership(projectId: string, projectName: string, activePartnerIds: string[]) {
    const active = new Set(activePartnerIds);
    for (const partnerId of await this.profiles.partnerIds()) {
      await (await this.store(partnerId)).setState(projectId, active.has(partnerId) ? 'active' : 'inactive', projectName);
    }
  }

  async archiveProject(projectId: string, projectName: string) {
    const archived: ProjectNotebook[] = [];
    for (const partnerId of await this.profiles.partnerIds()) {
      const notebook = await (await this.store(partnerId)).setState(projectId, 'archived', projectName);
      if (notebook) archived.push(notebook);
    }
    return archived;
  }

  async restoreProject(notebooks: ProjectNotebook[]) {
    for (const notebook of notebooks) await (await this.store(notebook.partnerId)).restore(notebook);
  }

  async listArchived() {
    const notebooks: ProjectNotebook[] = [];
    for (const partnerId of await this.profiles.partnerIds()) {
      notebooks.push(...await (await this.store(partnerId)).list({ includeArchived: true }).then((items) => items.filter((item) => item.state === 'archived')));
    }
    return notebooks.sort((left, right) => (right.archivedAt ?? '').localeCompare(left.archivedAt ?? '') || left.partnerId.localeCompare(right.partnerId));
  }

  async getArchived(partnerId: string, projectId: string) {
    const notebook = await (await this.store(partnerId)).get(projectId, { includeArchived: true });
    if (!notebook || notebook.state !== 'archived') throw new Error('PROJECT_NOTEBOOK_ARCHIVED_NOT_FOUND');
    return notebook;
  }

  async purgeArchived(partnerId: string, projectId: string) {
    return (await this.store(partnerId)).purgeArchived(projectId);
  }

  async assertActiveMembership(partnerId: string, projectId: string) {
    const project = await this.domain.getProject(projectId);
    if (!project) throw new Error('PROJECT_NOT_FOUND');
    if (!project.memberIds.includes(partnerId)) throw new Error('PROJECT_NOTEBOOK_ACCESS_DENIED');
    return project;
  }

  async listAccessibleProjects(partnerId: string) {
    const snapshot = await this.domain.snapshot();
    return snapshot.projects
      .filter((project) => project.memberIds.includes(partnerId))
      .map((project) => ({ projectId: project.id, name: project.name, status: project.status }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  notebookStore(partnerId: string) {
    return this.store(partnerId);
  }

  private store(partnerId: string) {
    let store = this.stores.get(partnerId);
    if (!store) {
      store = this.profiles.workMemoryDirectory(partnerId).then((directory) => new PartnerProjectNotebookStore(directory, partnerId));
      this.stores.set(partnerId, store);
    }
    return store;
  }
}
