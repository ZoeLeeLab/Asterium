import type { PartnerEvent } from '../../shared/agentProtocol';
import type { ProjectFilesSnapshot } from '../../shared/projectWorkspace';
import type { StudioRoomStore } from '../studio/StudioRoomStore';
import type { ArtifactRegistry } from '../security/ArtifactRegistry';
import type { ArtifactDeliveryService, DeliverArtifactInput } from './ArtifactDeliveryService';

interface ProjectFileDeliveryCoordinatorOptions {
  delivery: Pick<ArtifactDeliveryService, 'deliver' | 'listProjectFiles'>;
  artifacts: Pick<ArtifactRegistry, 'register'>;
  rooms: Pick<StudioRoomStore, 'getRoom'>;
  publish: (snapshot: ProjectFilesSnapshot) => void;
}

export class ProjectFileDeliveryCoordinator {
  constructor(private readonly options: ProjectFileDeliveryCoordinatorOptions) {}

  async deliver(input: DeliverArtifactInput) {
    const result = await this.options.delivery.deliver(input);
    await this.publish(input.projectId);
    return result;
  }

  async deliverExplicitStudioFile(event: Extract<PartnerEvent, { type: 'file.produced' }>, artifactId: string) {
    if (event.registrationMethod !== 'deliver_tool') return undefined;
    if (event.route?.scope === 'workspace') return this.deliver({ artifactId, projectId: event.route.projectId, source: 'partner' });
    if (event.route?.scope !== 'group') return undefined;
    const room = await this.options.rooms.getRoom(event.route.roomId);
    if (!room) throw new Error('STUDIO_ROOM_NOT_FOUND');
    return this.deliver({ artifactId, projectId: room.metadata.projectId, source: 'partner' });
  }

  async registerRuntimeFile(event: Extract<PartnerEvent, { type: 'file.produced' }>, artifactBaseDirectory?: string) {
    const claim = event.source ?? { kind: 'local_path' as const, path: event.artifactRef };
    const registryId = `${event.runId}:${event.artifactId}`;
    const info = await this.options.artifacts.register(claim, {
      id: registryId,
      name: event.name,
      mediaType: event.mediaType,
      baseDirectory: artifactBaseDirectory,
      partnerId: event.partnerId,
      conversationId: event.conversationId,
      sessionId: event.sessionId,
      runId: event.runId,
      toolCallId: event.toolCallId,
      method: event.registrationMethod ?? 'automatic',
      createdAt: event.occurredAt,
    }).catch(() => undefined);
    if (!info) return undefined;
    const delivery = await this.deliverExplicitStudioFile(event, info.id);
    return { info, delivery, emitArtifactEvent: info.id === registryId };
  }

  async publish(projectId: string) {
    const files = await this.options.delivery.listProjectFiles(projectId);
    this.options.publish({ projectId, files });
    return files;
  }
}
