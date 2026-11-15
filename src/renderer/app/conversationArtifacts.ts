import type { ArtifactInfo } from '../../shared/desktopBridge';
import type { ConversationArtifact } from '../types/domain';

export function deliverySourceKey(artifact: ConversationArtifact) {
  return artifact.sourceKind === 'local_path' && artifact.localSourceKey ? `local:${artifact.localSourceKey}` : `record:${artifact.id}`;
}

export function latestDeliveriesBySource(artifacts: ConversationArtifact[]) {
  const latest = new Map<string, ConversationArtifact>();
  for (const artifact of artifacts) {
    const key = deliverySourceKey(artifact);
    const previous = latest.get(key);
    if (!previous || artifact.createdAt >= previous.createdAt) latest.set(key, artifact);
  }
  return [...latest.values()];
}

export function updateDeliveryInfo(artifact: ConversationArtifact | undefined, info: ArtifactInfo): ConversationArtifact {
  if (artifact && artifact.name === info.name && artifact.mediaType === info.mediaType && artifact.sizeBytes === info.sizeBytes
    && artifact.sourceKind === info.sourceKind && artifact.registrationMethod === info.registrationMethod
    && artifact.availability === info.availability && artifact.cached === info.cached && artifact.localSourceKey === info.localSourceKey) return artifact;
  return {
    ...artifact,
    id: artifact?.id ?? info.id, artifactRef: info.id, createdAt: artifact?.createdAt ?? info.createdAt,
    name: info.name, mediaType: info.mediaType, sizeBytes: info.sizeBytes,
    sourceKind: info.sourceKind, registrationMethod: info.registrationMethod,
    availability: info.availability, cached: info.cached, localSourceKey: info.localSourceKey,
  };
}
