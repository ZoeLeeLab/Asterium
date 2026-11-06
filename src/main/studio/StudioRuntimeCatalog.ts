import type {
  ApiPartnerConnection,
  AsteriumRuntimeContextInput,
  AttachmentCapabilities,
  CodexRuntimeInfo,
  JsonValue,
  PartnerProfileSeed,
  PartnerProfilesSyncResult,
  PartnerWorkspaceState,
  RuntimeModelObservation,
  ConnectionSource,
} from '../../shared/agentProtocol';

export const STUDIO_RUNTIME_SETTINGS_KEY = '__studioRuntime';

export type StudioPartnerRuntime = {
  kind: 'api';
  connection: ApiPartnerConnection;
} | {
  kind: 'local';
  adapterType: 'claude_code' | 'codex_cli';
  partnerRootGrantId?: string;
  workspaceGrantIds: string[];
  codexRuntimeId?: string;
  codexRuntimeEnvironment?: CodexRuntimeInfo['environment'];
} | { kind: 'unsupported' };

export interface StudioPartnerRecord {
  partnerId: string;
  sourceMode: ConnectionSource;
  publicIdentity: PartnerProfileSeed['publicIdentity'];
  management: PartnerProfileSeed['management'];
  personality?: string;
  systemPrompt?: string;
  available: boolean;
  recentModel?: RuntimeModelObservation;
  runtime: StudioPartnerRuntime;
  runtimeContext: NonNullable<AsteriumRuntimeContextInput['runtime']>;
  fallbackModel: string;
}

type UserProfile = { displayName: string; introduction: string; updatedAt: string };

export class StudioRuntimeCatalog {
  private userProfile: UserProfile = { displayName: '用户', introduction: '', updatedAt: '' };
  private readonly partners = new Map<string, StudioPartnerRecord>();

  sync(user: UserProfile, seeds: PartnerProfileSeed[]) {
    this.userProfile = { ...user };
    this.partners.clear();
    for (const seed of seeds) this.upsert(seed);
  }

  applyProfiles(profiles: PartnerProfilesSyncResult) {
    this.userProfile = { ...profiles.user };
    for (const snapshot of profiles.partners) {
      const partner = this.partners.get(snapshot.partnerId);
      if (!partner) continue;
      partner.publicIdentity = { ...snapshot.publicIdentity };
      partner.management = { ...snapshot.management };
      partner.personality = snapshot.personality;
      partner.systemPrompt = snapshot.systemPrompt;
      partner.recentModel = snapshot.recentModel ? { ...snapshot.recentModel } : partner.recentModel;
    }
  }

  updateUser(user: UserProfile) {
    this.userProfile = { ...user };
  }

  upsert(seed: PartnerProfileSeed) {
    const record = parseStudioPartner(seed);
    if (record) this.partners.set(seed.partnerId, record);
    else this.partners.delete(seed.partnerId);
  }

  updateWorkspace(workspace: PartnerWorkspaceState) {
    const partner = this.partners.get(workspace.partnerId);
    if (!partner) return;
    if (partner.runtime.kind === 'unsupported') return;
    if (partner.runtime.kind === 'local') {
      partner.runtime = {
        ...partner.runtime,
        ...(workspace.cwd?.grantId ? { partnerRootGrantId: workspace.cwd.grantId } : { partnerRootGrantId: undefined }),
        workspaceGrantIds: workspace.workspaces.map((item) => item.grantId),
      };
      return;
    }
    partner.runtime = {
      kind: 'api',
      connection: {
        ...partner.runtime.connection,
        ...(workspace.cwd?.grantId ? { primaryWorkspaceGrantId: workspace.cwd.grantId } : { primaryWorkspaceGrantId: undefined }),
        workspaceGrantIds: [...(workspace.cwd ? [workspace.cwd.grantId] : []), ...workspace.workspaces.map((item) => item.grantId)],
      },
    };
  }

  observeModel(partnerId: string, observation: RuntimeModelObservation) {
    const partner = this.partners.get(partnerId);
    if (partner) partner.recentModel = { ...observation };
  }

  user() {
    return { ...this.userProfile };
  }

  partner(partnerId: string) {
    return this.partners.get(partnerId);
  }

  allPartners() {
    return [...this.partners.values()];
  }

  members(partnerIds: string[]) {
    return partnerIds.map((partnerId) => this.partners.get(partnerId)).filter((partner): partner is StudioPartnerRecord => Boolean(partner));
  }
}

export function persistedPartnerProfileSeed(seed: PartnerProfileSeed): PartnerProfileSeed {
  const connectionSettings = { ...seed.connectionSettings };
  delete connectionSettings[STUDIO_RUNTIME_SETTINGS_KEY];
  delete connectionSettings.__diaryRuntime;
  return { ...seed, connectionSettings };
}

export function shouldPersistPartnerProfileSeed(seed: PartnerProfileSeed) {
  const runtime = seed.connectionSettings[STUDIO_RUNTIME_SETTINGS_KEY];
  return !isRecord(runtime) || runtime.persist !== false;
}

function parseStudioPartner(seed: PartnerProfileSeed): StudioPartnerRecord | undefined {
  const raw = seed.connectionSettings[STUDIO_RUNTIME_SETTINGS_KEY];
  const parsedRuntime = isRecord(raw) && isRecord(raw.runtime) ? parseRuntime(raw.runtime) : undefined;
  const runtime = parsedRuntime && ((seed.sourceMode === 'api_partner' && parsedRuntime.kind === 'api') || (seed.sourceMode === 'local_cli' && parsedRuntime.kind === 'local'))
    ? parsedRuntime
    : undefined;
  const recentModel = isRecord(raw) ? parseRecentModel(raw.recentModel) : undefined;
  const resolvedRuntime = runtime ?? { kind: 'unsupported' as const };
  const runtimeContext = resolvedRuntime.kind === 'api'
    ? { source: 'api_partner' as const, provider: resolvedRuntime.connection.provider, model: resolvedRuntime.connection.model }
    : resolvedRuntime.kind === 'local'
      ? { source: 'local_cli' as const, adapter: resolvedRuntime.adapterType }
      : { source: seed.sourceMode };
  return {
    partnerId: seed.partnerId,
    sourceMode: seed.sourceMode,
    publicIdentity: { ...seed.publicIdentity },
    management: { ...seed.management },
    ...(seed.personality ? { personality: seed.personality } : {}),
    ...(seed.systemPrompt ? { systemPrompt: seed.systemPrompt } : {}),
    available: Boolean(runtime && isRecord(raw) && raw.available === true),
    ...(recentModel ? { recentModel } : {}),
    runtime: resolvedRuntime,
    runtimeContext,
    fallbackModel: runtime?.kind === 'api' ? runtime.connection.model : '尚未报告',
  };
}

function parseRuntime(value: Record<string, unknown>): StudioPartnerRuntime | undefined {
  if (value.kind === 'api' && isRecord(value.connection)) {
    const connection = value.connection;
    if (!['deepseek', 'openai', 'responses', 'anthropic', 'gemini', 'custom'].includes(String(connection.provider))
      || typeof connection.endpoint !== 'string' || typeof connection.model !== 'string' || typeof connection.credentialRef !== 'string') return undefined;
    const attachmentCapabilities = parseAttachmentCapabilities(connection.attachmentCapabilities);
    return {
      kind: 'api',
      connection: {
        provider: connection.provider as ApiPartnerConnection['provider'],
        endpoint: connection.endpoint,
        model: connection.model,
        credentialRef: connection.credentialRef,
        ...(typeof connection.modelId === 'string' ? { modelId: connection.modelId } : {}),
        ...(isThinkingMode(connection.thinkingMode) ? { thinkingMode: connection.thinkingMode } : {}),
        ...(isReasoningEffort(connection.reasoningEffort) ? { reasoningEffort: connection.reasoningEffort } : {}),
        ...(typeof connection.primaryWorkspaceGrantId === 'string' ? { primaryWorkspaceGrantId: connection.primaryWorkspaceGrantId } : {}),
        ...(isStringArray(connection.workspaceGrantIds) ? { workspaceGrantIds: connection.workspaceGrantIds } : {}),
        ...(attachmentCapabilities ? { attachmentCapabilities } : {}),
      },
    };
  }
  if (value.kind === 'local' && (value.adapterType === 'claude_code' || value.adapterType === 'codex_cli')) return {
    kind: 'local',
    adapterType: value.adapterType,
    ...(typeof value.partnerRootGrantId === 'string' ? { partnerRootGrantId: value.partnerRootGrantId } : {}),
    workspaceGrantIds: isStringArray(value.workspaceGrantIds) ? value.workspaceGrantIds : [],
    ...(typeof value.codexRuntimeId === 'string' ? { codexRuntimeId: value.codexRuntimeId } : {}),
    ...(isCodexRuntimeEnvironment(value.codexRuntimeEnvironment) ? { codexRuntimeEnvironment: value.codexRuntimeEnvironment } : {}),
  };
  return undefined;
}

function parseRecentModel(value: unknown): RuntimeModelObservation | undefined {
  if (!isRecord(value) || typeof value.model !== 'string' || !['current', 'recent', 'unknown'].includes(String(value.status))
    || typeof value.observedAt !== 'string' || !['runtime', 'native_thread', 'history'].includes(String(value.source))) return undefined;
  return value as unknown as RuntimeModelObservation;
}

function isThinkingMode(value: unknown): value is NonNullable<ApiPartnerConnection['thinkingMode']> {
  return value === 'auto' || value === 'enabled' || value === 'disabled';
}

function isReasoningEffort(value: unknown): value is NonNullable<ApiPartnerConnection['reasoningEffort']> {
  return value === 'low' || value === 'high' || value === 'max';
}

function isCodexRuntimeEnvironment(value: unknown): value is CodexRuntimeInfo['environment'] {
  return value === 'global_cli' || value === 'desktop_app' || value === 'vscode_extension' || value === 'path';
}

function parseAttachmentCapabilities(value: unknown): AttachmentCapabilities | undefined {
  if (!isRecord(value) || typeof value.supportsImageInput !== 'boolean' || !isStringArray(value.acceptedMimeTypes)
    || typeof value.maxImageBytes !== 'number' || !['metadata_only', 'native_multimodal', 'local_path'].includes(String(value.attachmentTransport))) return undefined;
  return {
    supportsImageInput: value.supportsImageInput,
    acceptedMimeTypes: value.acceptedMimeTypes,
    maxImageBytes: value.maxImageBytes,
    attachmentTransport: value.attachmentTransport as AttachmentCapabilities['attachmentTransport'],
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: JsonValue | unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
