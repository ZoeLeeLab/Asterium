import type { ConnectionSource, JsonValue, RuntimeModelObservation } from './core';

export type MemoryManagementMode = 'none' | 'self_managed' | 'asterium';

export interface PartnerProfileManagement {
  userProfile: boolean;
  personality: boolean;
  memoryMode: MemoryManagementMode;
}

export interface PartnerProfileSeed {
  partnerId: string;
  expectedRevision?: string;
  sourceMode: ConnectionSource;
  publicIdentity: {
    displayName: string;
    introduction: string;
    expertise: string;
    mentionName: string;
    avatarDataUrl?: string;
  };
  management: PartnerProfileManagement;
  personality?: string;
  systemPrompt?: string;
  connectionSettings: { [key: string]: JsonValue };
}

export interface PartnerProfileSnapshot {
  partnerId: string;
  directoryName: string;
  revision?: string;
  publicIdentity: PartnerProfileSeed['publicIdentity'];
  management: PartnerProfileManagement;
  personality?: string;
  systemPrompt?: string;
  recentModel?: RuntimeModelObservation;
  conversationModels: Record<string, RuntimeModelObservation>;
}

export interface PartnerProfilesSyncResult {
  user: { displayName: string; introduction: string; updatedAt: string; revision?: string };
  partners: PartnerProfileSnapshot[];
}
