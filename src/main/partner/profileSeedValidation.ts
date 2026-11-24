import {
  type PartnerProfileSeed
} from '../../shared/agentProtocol';
export function isUserProfileSeed(value: unknown): value is { displayName: string; introduction: string; updatedAt: string; revision?: string } {
  return isRecord(value)
    && typeof value.displayName === 'string' && value.displayName.length <= 80
    && typeof value.introduction === 'string' && value.introduction.length <= 20_000
    && typeof value.updatedAt === 'string'
    && (value.revision === undefined || typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision));
}

export function isPartnerProfileSeed(value: unknown): value is PartnerProfileSeed {
  if (!isRecord(value) || typeof value.partnerId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value.partnerId)
    || !['existing_thread', 'local_cli', 'api_partner'].includes(String(value.sourceMode))
    || !isRecord(value.publicIdentity) || !isRecord(value.management) || !isRecord(value.connectionSettings)) return false;
  const identity = value.publicIdentity;
  return typeof identity.displayName === 'string' && identity.displayName.length <= 80
    && typeof identity.introduction === 'string' && identity.introduction.length <= 20_000
    && typeof identity.expertise === 'string' && identity.expertise.length <= 20_000
    && typeof identity.mentionName === 'string' && identity.mentionName.length <= 80
    && (identity.avatarDataUrl === undefined || typeof identity.avatarDataUrl === 'string')
    && typeof value.management.personality === 'boolean'
    && ['none', 'self_managed', 'asterium'].includes(String(value.management.memoryMode))
    && typeof value.management.userProfile === 'boolean'
    && (value.personality === undefined || (typeof value.personality === 'string' && value.personality.length <= 40_000))
    && (value.systemPrompt === undefined || (typeof value.systemPrompt === 'string' && value.systemPrompt.length <= 80_000))
    && (value.expectedRevision === undefined || typeof value.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(value.expectedRevision))
    && isJsonRecord(value.connectionSettings);
}

function isJsonRecord(value: Record<string, unknown>) {
  const valid = (item: unknown, depth: number): boolean => depth <= 8 && (
    item === null || ['string', 'number', 'boolean'].includes(typeof item)
    || (Array.isArray(item) && item.length <= 500 && item.every((entry) => valid(entry, depth + 1)))
    || (isRecord(item) && Object.keys(item).length <= 200 && Object.values(item).every((entry) => valid(entry, depth + 1)))
  );
  return valid(value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
