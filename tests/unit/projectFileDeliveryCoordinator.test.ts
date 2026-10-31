import { describe, expect, it, vi } from 'vitest';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent } from '../../src/shared/agentProtocol';
import { ProjectFileDeliveryCoordinator } from '../../src/main/project/ProjectFileDeliveryCoordinator';

type ProducedFileEvent = Extract<PartnerEvent, { type: 'file.produced' }>;

function producedFile(registrationMethod: ProducedFileEvent['registrationMethod'], group = true): ProducedFileEvent {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'file.produced',
    eventId: 'event-1',
    partnerId: 'partner-1',
    conversationId: group ? 'group:v3:room-1:partner-1' : 'conversation-1',
    connectionSource: 'local_cli',
    clientMessageId: 'message-1',
    sessionId: 'session-1',
    runId: 'run-1',
    sequence: 3,
    occurredAt: '2026-10-14T00:00:00.000Z',
    artifactId: 'runtime-artifact-1',
    artifactRef: 'registry-pending',
    name: 'result.md',
    registrationMethod,
    ...(group ? { route: { scope: 'group', roomId: 'room-1', roundId: 'round-1', bindingGeneration: 2, inputThroughSeq: 4 } as const } : {}),
  };
}

describe('ProjectFileDeliveryCoordinator', () => {
  it('uses the Main-owned room project for explicit Studio delivery and publishes the authoritative snapshot', async () => {
    const files = [{ name: 'result.md', relativePath: 'deliverables/partner/result.md', sizeBytes: 12, modifiedAt: '2026-10-14T00:00:01.000Z' }];
    const delivery = {
      deliver: vi.fn(async () => ({ artifactId: 'registry-artifact-1', projectId: 'project-1' })),
      listProjectFiles: vi.fn(async () => files),
    };
    const publish = vi.fn();
    const coordinator = new ProjectFileDeliveryCoordinator({
      delivery: delivery as never,
      artifacts: { register: vi.fn() } as never,
      rooms: { getRoom: vi.fn(async () => ({ metadata: { roomId: 'room-1', projectId: 'project-1', name: '项目群聊', memberIds: ['partner-1'] } })) } as never,
      publish,
    });

    await coordinator.deliverExplicitStudioFile(producedFile('deliver_tool'), 'registry-artifact-1');

    expect(delivery.deliver).toHaveBeenCalledWith({ artifactId: 'registry-artifact-1', projectId: 'project-1', source: 'partner' });
    expect(delivery.listProjectFiles).toHaveBeenCalledWith('project-1');
    expect(publish).toHaveBeenCalledWith({ projectId: 'project-1', files });
  });

  it('does not formally deliver automatic intermediate files or non-Studio deliveries', async () => {
    const delivery = { deliver: vi.fn(), listProjectFiles: vi.fn() };
    const rooms = { getRoom: vi.fn() };
    const coordinator = new ProjectFileDeliveryCoordinator({ delivery: delivery as never, artifacts: { register: vi.fn() } as never, rooms: rooms as never, publish: vi.fn() });

    await expect(coordinator.deliverExplicitStudioFile(producedFile('automatic'), 'automatic-artifact')).resolves.toBeUndefined();
    await expect(coordinator.deliverExplicitStudioFile(producedFile('deliver_tool', false), 'single-artifact')).resolves.toBeUndefined();

    expect(rooms.getRoom).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(delivery.listProjectFiles).not.toHaveBeenCalled();
  });

  it('still formally delivers an explicit file when Registry deduplicates its earlier automatic event', async () => {
    const existingInfo = {
      id: 'existing-automatic-artifact', name: 'result.md', mediaType: 'text/markdown', sizeBytes: 12,
      sourceKind: 'local_path', registrationMethod: 'automatic', availability: 'available', cached: false,
    };
    const delivery = {
      deliver: vi.fn(async () => ({ artifactId: existingInfo.id, projectId: 'project-1' })),
      listProjectFiles: vi.fn(async () => []),
    };
    const coordinator = new ProjectFileDeliveryCoordinator({
      delivery: delivery as never,
      artifacts: { register: vi.fn(async () => existingInfo) } as never,
      rooms: { getRoom: vi.fn(async () => ({ metadata: { roomId: 'room-1', projectId: 'project-1', name: '项目群聊', memberIds: ['partner-1'] } })) } as never,
      publish: vi.fn(),
    });

    const result = await coordinator.registerRuntimeFile(producedFile('deliver_tool'));

    expect(result).toMatchObject({ info: { id: existingInfo.id }, emitArtifactEvent: false });
    expect(delivery.deliver).toHaveBeenCalledWith({ artifactId: existingInfo.id, projectId: 'project-1', source: 'partner' });
    expect(delivery.listProjectFiles).toHaveBeenCalledWith('project-1');
  });
});
