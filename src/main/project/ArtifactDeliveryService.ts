import type { ArtifactRegistry } from '../security/ArtifactRegistry';
import type { ProjectWorkspaceStore } from './ProjectWorkspaceStore';
import type { ProjectFileStore } from './ProjectFileStore';
import { ProjectMutationCoordinator } from './ProjectMutationCoordinator';

interface ArtifactDeliveryServiceOptions {
  artifacts: Pick<ArtifactRegistry, 'pathFor' | 'inspect' | 'listProjectDeliveries' | 'originalPathFor'>;
  workspaces: Pick<ProjectWorkspaceStore, 'get'>;
  files: Pick<ProjectFileStore, 'register' | 'list' | 'initializeProject'>;
  partnerName: (partnerId: string) => Promise<string | undefined>;
  coordinator?: ProjectMutationCoordinator;
}

export interface DeliverArtifactInput {
  artifactId: string;
  projectId: string;
  source: 'partner' | 'user';
}

export class ArtifactDeliveryService {
  private readonly coordinator: ProjectMutationCoordinator;

  constructor(private readonly options: ArtifactDeliveryServiceOptions) {
    this.coordinator = options.coordinator ?? new ProjectMutationCoordinator();
  }

  deliver(input: DeliverArtifactInput) {
    return this.coordinator.run(() => this.deliverUnlocked(input));
  }

  private async deliverUnlocked(input: DeliverArtifactInput) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.projectId)) throw new Error('ARTIFACT_PROJECT_ID_REJECTED');
    this.coordinator.assertProjectActive(input.projectId);
    const sourcePath = await this.options.artifacts.pathFor(input.artifactId);
    const info = await this.options.artifacts.inspect(input.artifactId);
    const sourcePartnerId = input.source === 'partner' ? info.partnerId : undefined;
    const sourcePartnerName = sourcePartnerId ? await this.options.partnerName(sourcePartnerId) ?? sourcePartnerId : undefined;
    const delivered = await this.options.files.register({
      projectId: input.projectId,
      sourcePath,
      name: info.name,
      artifactId: info.id,
      ...(sourcePartnerId ? { sourcePartnerId } : {}),
      ...(sourcePartnerName ? { sourcePartnerName } : {}),
    });
    const result: Omit<typeof delivered, 'created'> & { created?: boolean } = { ...delivered };
    delete result.created;
    return { artifactId: info.id, projectId: input.projectId, name: info.name, ...result };
  }

  async listProjectFiles(projectId: string) {
    return this.options.files.list(projectId);
  }

  async initializeProject(projectId: string) {
    const workspace = await this.options.workspaces.get(projectId);
    if (!workspace) throw new Error('PROJECT_WORKSPACE_NOT_READY');
    const deliveries = await this.options.artifacts.listProjectDeliveries(projectId);
    const legacy = await Promise.all(deliveries.map(async (delivery) => ({
      artifactId: delivery.artifactId,
      relativePath: delivery.relativePath,
      originalPath: await this.options.artifacts.originalPathFor(delivery.artifactId).catch(() => undefined),
      sourcePartnerId: delivery.sourcePartnerId,
      sourcePartnerName: delivery.sourcePartnerName,
    })));
    await this.options.files.initializeProject(workspace, legacy);
    return this.options.files.list(projectId);
  }
}
