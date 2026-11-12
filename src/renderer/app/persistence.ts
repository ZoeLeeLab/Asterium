import { createInitialState } from '../data/initialState';
import { COMMON_IMAGE_MIME_TYPES, type AttachmentCapabilities, type MemoryManagementMode, type MessageAttachment, type PermissionMode, type RuntimeModelObservation } from '../../shared/agentProtocol';
import type { MessageQuote, Partner, ProjectFile, PrototypeState, PublicIdentity, TaskItem, ThemeMode, UserProfile } from '../types/domain';
import { isProjectStatus, isProjectTaskStatus } from '../../shared/projectDomain';
import { sanitizePngDataUrl } from './pngDataUrl';
import { ASTERIUM_USER_ID, normalizeAsteriumUserAuthorId, normalizeAsteriumUserId } from '../../shared/identity';

import { isCodexModelSelection } from '../../shared/codexModels';

export const STATE_KEY = 'asterium.prototype.v7';
export const THEME_KEY = 'asterium.theme.v1';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function textList(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))] : [];
}

function permissionMode(value: unknown, fallback: PermissionMode = 'manual'): PermissionMode {
  return ['read_only', 'manual', 'automatic', 'full'].includes(text(value)) ? value as PermissionMode : fallback;
}

function memoryManagementMode(source: Partner['sourceMode'], management: UnknownRecord): MemoryManagementMode {
  if (source === 'existing_thread') return 'none';
  if (source === 'api_partner') return 'asterium';
  if (management.memoryMode === 'asterium' || management.memoryMode === 'self_managed') return management.memoryMode;
  return management.privateMemory === true ? 'asterium' : 'self_managed';
}

function runtimeModel(value: unknown): RuntimeModelObservation | undefined {
  if (!isRecord(value) || !text(value.model).trim() || !['current', 'recent', 'unknown'].includes(text(value.status))
    || !['runtime', 'native_thread', 'history'].includes(text(value.source)) || !text(value.observedAt)) return undefined;
  return {
    model: text(value.model), status: value.status as RuntimeModelObservation['status'], source: value.source as RuntimeModelObservation['source'], observedAt: text(value.observedAt),
    ...(text(value.conversationId) ? { conversationId: text(value.conversationId) } : {}),
    ...(text(value.threadId) ? { threadId: text(value.threadId) } : {}),
  };
}

function eventSequences(value: unknown) {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([runId, sequence]) => Boolean(runId) && Number.isSafeInteger(sequence) && Number(sequence) >= 0).slice(-32);
  return entries.length ? Object.fromEntries(entries.map(([runId, sequence]) => [runId, Number(sequence)])) : undefined;
}

function attachmentCapabilities(value: unknown, source: Partner['sourceMode']): AttachmentCapabilities {
  const defaults: AttachmentCapabilities = source === 'local_cli'
    ? { supportsImageInput: true, acceptedMimeTypes: [...COMMON_IMAGE_MIME_TYPES], maxImageBytes: 20 * 1024 * 1024, attachmentTransport: 'local_path' }
    : { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' };
  if (!isRecord(value)) return defaults;
  const transport = ['local_path', 'native_multimodal', 'metadata_only'].includes(text(value.attachmentTransport))
    ? value.attachmentTransport as AttachmentCapabilities['attachmentTransport'] : defaults.attachmentTransport;
  return {
    supportsImageInput: value.supportsImageInput === true,
    acceptedMimeTypes: textList(value.acceptedMimeTypes).map((item) => item.toLocaleLowerCase()),
    maxImageBytes: Number.isSafeInteger(value.maxImageBytes) && Number(value.maxImageBytes) >= 0 ? Number(value.maxImageBytes) : defaults.maxImageBytes,
    attachmentTransport: transport,
  };
}

function normalizeMessageAttachment(value: unknown): MessageAttachment | null {
  if (!isRecord(value) || !text(value.id) || !text(value.name) || !text(value.mediaType)
    || !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0) return null;
  return { id: text(value.id), name: text(value.name), mediaType: text(value.mediaType).toLocaleLowerCase(), sizeBytes: Number(value.sizeBytes) };
}

function normalizeMessageQuote(value: unknown): MessageQuote | null {
  if (!isRecord(value) || !text(value.sourceMessageId) || !text(value.sourcePartnerId) || !text(value.sourcePartnerName)
    || !['full', 'selection'].includes(text(value.kind)) || !text(value.text).trim()) return null;
  return {
    sourceMessageId: text(value.sourceMessageId),
    sourcePartnerId: text(value.sourcePartnerId),
    sourcePartnerName: text(value.sourcePartnerName),
    kind: value.kind as MessageQuote['kind'],
    text: text(value.text),
  };
}

function normalizeUserProfile(value: unknown): UserProfile {
  const profile = isRecord(value) ? value : {};
  const avatarDataUrl = sanitizePngDataUrl(text(profile.avatarDataUrl));
  const rawAudience = text(profile.audience);
  const audience: UserProfile['audience'] = ['local_cli', 'api_partner', 'all'].includes(rawAudience)
    ? rawAudience as UserProfile['audience']
    : 'all';
  return {
    id: normalizeAsteriumUserId(),
    displayName: text(profile.displayName, '用户').trim() || '用户',
    ...(avatarDataUrl ? { avatarDataUrl } : {}),
    introduction: text(profile.introduction),
    audience,
    ...(text(profile.revision) ? { revision: text(profile.revision) } : {}),
    updatedAt: text(profile.updatedAt, new Date().toISOString()),
  };
}

function publicIdentity(value: UnknownRecord): PublicIdentity {
  const nested = isRecord(value.publicIdentity) ? value.publicIdentity : {};
  const displayName = text(nested.displayName, text(value.name, '未命名伙伴'));
  const avatarDataUrl = sanitizePngDataUrl(text(nested.avatarDataUrl, text(value.avatarDataUrl)));
  return {
    displayName,
    ...(avatarDataUrl ? { avatarDataUrl } : {}),
    introduction: text(nested.introduction, text(value.intro)),
    expertise: text(nested.expertise),
    mentionName: text(nested.mentionName, displayName.replace(/^@/, '').replace(/\s+/g, '') || '伙伴'),
  };
}

function codexRuntime(value: unknown) {
  if (!isRecord(value)) return undefined;
  const environment = ['global_cli', 'desktop_app', 'vscode_extension', 'path'].includes(text(value.environment))
    ? text(value.environment) as 'global_cli' | 'desktop_app' | 'vscode_extension' | 'path'
    : 'path' as const;
  return {
    ...(text(value.executablePath) ? { executablePath: text(value.executablePath) } : {}),
    executableLabel: text(value.executableLabel, 'codex.exe'),
    environment,
    environmentLabel: text(value.environmentLabel, 'Codex CLI'),
    codexHome: text(value.codexHome),
    loggedIn: value.loggedIn === true,
    ...(text(value.version) ? { version: text(value.version) } : {}),
    ...(text(value.authMethod) ? { authMethod: text(value.authMethod) } : {}),
  };
}

function normalizePartner(value: unknown): Partner | null {
  if (!isRecord(value)) return null;
  const source = value.sourceMode === 'existing_cli' ? 'local_cli' : value.sourceMode;
  const capabilitySource: Partner['sourceMode'] = source === 'local_cli' || source === 'api_partner' ? source : 'existing_thread';
  const storedManagement = isRecord(value.profileManagement) ? value.profileManagement : {};
  const common = {
    id: text(value.id),
    publicIdentity: publicIdentity(value),
    status: ['online', 'connecting', 'busy', 'awaiting_confirmation', 'offline', 'failed'].includes(text(value.status))
      ? value.status as Partner['status'] : 'offline' as const,
    isPrototype: value.isPrototype !== false,
    createdAt: text(value.createdAt, new Date().toISOString()),
    accent: text(value.accent, '#69a7ff'),
    attachmentCapabilities: attachmentCapabilities(value.attachmentCapabilities, capabilitySource),
    defaultPermissionMode: permissionMode(value.defaultPermissionMode),
    ...(text(value.profileRevision) ? { profileRevision: text(value.profileRevision) } : {}),
    profileManagement: {
      userProfile: storedManagement.userProfile === true || (storedManagement.userProfile === undefined && capabilitySource === 'api_partner'),
      personality: storedManagement.personality === true || (storedManagement.personality === undefined && capabilitySource === 'api_partner'),
      memoryMode: memoryManagementMode(capabilitySource, storedManagement),
    },
    ...(typeof value.managedPersonality === 'string' ? { managedPersonality: value.managedPersonality } : {}),
    ...(typeof value.managedSystemPrompt === 'string' ? { managedSystemPrompt: value.managedSystemPrompt } : {}),
    ...(runtimeModel(value.recentModel) ? { recentModel: runtimeModel(value.recentModel) } : {}),
    ...(value.isRemoved === true ? { isRemoved: true, removedAt: text(value.removedAt, new Date().toISOString()) } : {}),
    ...(text(value.managedDataDeletedAt) ? { managedDataDeletedAt: text(value.managedDataDeletedAt) } : {}),
  };
  if (!common.id) return null;

  if (source === 'local_cli') {
    const legacyDirectory = text(value.workingDirectory);
    const workingDirectories = textList(value.workingDirectories);
    if (!workingDirectories.length && legacyDirectory) workingDirectories.push(legacyDirectory);
    const legacyGrantId = text(value.workspaceGrantId);
    const workspaceGrantIds = textList(value.workspaceGrantIds);
    if (!workspaceGrantIds.length && legacyGrantId) workspaceGrantIds.push(legacyGrantId);
    const legacyPrimaryGrantId = text(value.primaryWorkspaceGrantId, legacyGrantId || workspaceGrantIds[0]);
    const explicitPrivateRoot = value.partnerRootKind === 'private';
    const partnerRootGrantId = explicitPrivateRoot ? '' : text(value.partnerRootGrantId, legacyPrimaryGrantId);
    const partnerRootIndex = workspaceGrantIds.indexOf(partnerRootGrantId);
    const partnerRoot = text(value.partnerRoot, legacyDirectory || workingDirectories[partnerRootIndex]);
    const extraGrantIds = workspaceGrantIds.filter((grantId) => grantId !== partnerRootGrantId);
    const extraDirectories = workingDirectories.filter((_, index) => workspaceGrantIds[index] !== partnerRootGrantId);
    return {
    ...common,
    sourceMode: 'local_cli',
    adapterType: value.adapterType === 'codex_cli' ? 'codex_cli' : 'claude_code',
    location: value.location === 'remote' ? 'remote' : 'local',
    sessionMode: value.sessionMode === 'resume' ? 'resume' : 'new',
    connectionLabel: text(value.connectionLabel, '本机 CLI'),
    connectionKind: value.connectionKind === 'local_codex' ? 'local_codex' : value.connectionKind === 'local_claude' ? 'local_claude' : 'mock',
    ...(text(value.cliVersion) ? { cliVersion: text(value.cliVersion) } : {}),
    ...(text(value.claudeVersion) ? { claudeVersion: text(value.claudeVersion) } : {}),
    ...(text(value.executableLabel) ? { executableLabel: text(value.executableLabel) } : {}),
    ...(text(value.codexRuntimeId) ? { codexRuntimeId: text(value.codexRuntimeId) } : {}),
    ...(codexRuntime(value.codexRuntime) ? { codexRuntime: codexRuntime(value.codexRuntime) } : {}),
    ...(text(value.resumeSessionId) ? { resumeSessionId: text(value.resumeSessionId) } : {}),
    ...(text(value.claudeSessionFilePath) ? { claudeSessionFilePath: text(value.claudeSessionFilePath) } : {}),
      ...((value.partnerRootKind === 'private' || value.partnerRootKind === 'imported' || partnerRootGrantId)
        ? { partnerRootKind: value.partnerRootKind === 'private' || !partnerRootGrantId ? 'private' as const : 'imported' as const }
        : {}),
      ...(partnerRoot ? { partnerRoot } : {}),
      ...(partnerRootGrantId ? { partnerRootGrantId } : {}),
      ...(extraDirectories.length ? { workingDirectories: extraDirectories, workingDirectory: extraDirectories[0] } : {}),
      ...(extraGrantIds.length ? { workspaceGrantIds: extraGrantIds, workspaceGrantId: extraGrantIds[0] } : {}),
      ...(text(value.activeWorkspaceGrantId) && extraGrantIds.includes(text(value.activeWorkspaceGrantId))
        ? { activeWorkspaceGrantId: text(value.activeWorkspaceGrantId) }
        : extraGrantIds[0] ? { activeWorkspaceGrantId: extraGrantIds[0] } : {}),
    };
  }
  if (source === 'existing_thread') {
    return {
    ...common,
    sourceMode: 'existing_thread',
    serviceType: value.serviceType === 'custom' ? 'custom'
      : value.serviceType === 'cyberboss_local' ? 'cyberboss_local' : 'cyberboss_server',
    serviceUrl: text(value.serviceUrl),
    threadId: text(value.threadId),
    ...(text(value.workspaceRoot) ? { workspaceRoot: text(value.workspaceRoot) } : {}),
    connectionLabel: text(value.connectionLabel, '现有线程 · 模拟连接'),
    connectionStatus: ['connected', 'failed', 'mock_connected'].includes(text(value.connectionStatus)) ? value.connectionStatus as 'connected' | 'failed' | 'mock_connected' : 'untested',
    ...(text(value.credentialRef) ? { credentialRef: text(value.credentialRef) } : {}),
    configured: value.configured === true,
    ...(isRecord(value.capabilities) ? { capabilities: {
      streamingText: value.capabilities.streamingText === true,
      cancellation: value.capabilities.cancellation === true,
      toolEvents: value.capabilities.toolEvents === true,
      fileEvents: value.capabilities.fileEvents === true,
      reconnect: value.capabilities.reconnect === true,
    } } : {}),
    };
  }
  if (source === 'api_partner') {
    return {
    ...common,
    sourceMode: 'api_partner',
    ...(text(value.modelId) ? { modelId: text(value.modelId) } : {}),
    provider: ['deepseek', 'openai', 'responses', 'anthropic', 'gemini', 'custom'].includes(text(value.provider))
      ? value.provider as 'deepseek' | 'openai' | 'responses' | 'anthropic' | 'gemini' | 'custom' : 'custom',
    ...(text(value.endpoint) ? { endpoint: text(value.endpoint) } : {}),
    model: text(value.model),
    personality: text(value.personality),
    ...(text(value.systemPrompt) ? { systemPrompt: text(value.systemPrompt) } : {}),
    apiSessionHistoryEnabled: typeof value.apiSessionHistoryEnabled === 'boolean'
      ? value.apiSessionHistoryEnabled
      : typeof value.memoryEnabled === 'boolean' ? value.memoryEnabled : true,
    thinkingMode: ['auto', 'enabled', 'disabled'].includes(text(value.thinkingMode))
      ? value.thinkingMode as 'auto' | 'enabled' | 'disabled' : 'auto',
    reasoningEffort: ['low', 'high', 'max'].includes(text(value.reasoningEffort))
      ? value.reasoningEffort as 'low' | 'high' | 'max' : 'high',
    ...(text(value.primaryWorkspaceGrantId) ? { primaryWorkspaceGrantId: text(value.primaryWorkspaceGrantId) } : {}),
    ...(textList(value.workingDirectories).length ? { workingDirectories: textList(value.workingDirectories) } : {}),
    ...(textList(value.workspaceGrantIds).length ? { workspaceGrantIds: textList(value.workspaceGrantIds) } : {}),
    ...(text(value.credentialRef) ? { credentialRef: text(value.credentialRef) } : {}),
    configured: value.configured === true,
    };
  }
  return null;
}

function normalizeProjectTask(value: unknown, projectId: string, projectCreatedAt: string, index: number): TaskItem {
  const task = isRecord(value) ? value : {};
  const rawStatus = text(task.status);
  const status: TaskItem['status'] = isProjectTaskStatus(rawStatus)
    ? rawStatus
    : rawStatus === 'approved' || rawStatus === 'delivered' ? 'completed'
      : rawStatus === 'review' ? 'review' : 'todo';
  const createdAt = text(task.createdAt, projectCreatedAt);
  const assigneeId = text(task.assigneeId, text(task.ownerId));
  return {
    version: 1,
    id: text(task.id, `${projectId}:task:${index + 1}`),
    projectId,
    code: text(task.code, `TSK-${String(index + 1).padStart(3, '0')}`),
    title: text(task.title, '未命名任务'),
    description: text(task.description),
    ...(assigneeId ? { assigneeId } : {}),
    status,
    dependencyIds: textList(task.dependencyIds),
    acceptanceCriteria: textList(task.acceptanceCriteria),
    note: text(task.note),
    revision: Number.isSafeInteger(task.revision) && Number(task.revision) > 0 ? Number(task.revision) : 1,
    createdAt,
    updatedAt: text(task.updatedAt, createdAt),
  };
}

function normalizeState(value: unknown): PrototypeState | null {
  if (!isRecord(value) || !Array.isArray(value.partners) || !Array.isArray(value.conversations) || !Array.isArray(value.projects)) return null;
  const partners = value.partners.map(normalizePartner).filter((partner): partner is Partner => partner !== null);
  let projects = (value.projects as Array<PrototypeState['projects'][number] & { messages?: unknown }>).map((storedProject) => {
    const project = { ...storedProject };
    delete project.messages;
    const createdAt = text(project.createdAt, new Date().toISOString());
    return {
      ...project,
      version: 1 as const,
      name: text(project.name, '未命名项目').trim() || '未命名项目',
      description: text(project.description),
      status: isProjectStatus(project.status) ? project.status : 'active' as const,
      progress: Number.isFinite(project.progress) ? Math.max(0, Math.min(100, Math.round(project.progress))) : 0,
      tags: textList(project.tags),
      memberIds: textList(project.memberIds),
      revision: Number.isSafeInteger(project.revision) && project.revision > 0 ? project.revision : 1,
      createdAt,
      updatedAt: text(project.updatedAt, createdAt),
      files: project.files.map((file) => {
        const normalized = { ...file } as ProjectFile & { blobHash?: unknown };
        delete normalized.blobHash;
        return normalized;
      }),
      tasks: (Array.isArray(project.tasks) ? project.tasks : []).map((task, index) => normalizeProjectTask(task, project.id, createdAt, index)),
      ...(project.avatarDataUrl ? { avatarDataUrl: sanitizePngDataUrl(project.avatarDataUrl) } : {}),
    };
  });
  const storedGroupChats: PrototypeState['groupChats'] = Array.isArray(value.groupChats) && value.groupChats.length
    ? value.groupChats as PrototypeState['groupChats']
    : projects.map((project) => ({
        id: `group-${project.id}`,
        projectId: project.id,
        name: `${project.name}讨论组`,
        memberIds: [...project.memberIds],
        // Deprecated Project.messages are intentionally discarded. Main's
        // Studio ledger is the only group transcript source.
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
  const groupChats = storedGroupChats.map((groupChat) => ({
    ...groupChat,
    // Main-owned studio ledger is the only group transcript source.
    messages: [],
    ...(groupChat.avatarDataUrl ? { avatarDataUrl: sanitizePngDataUrl(groupChat.avatarDataUrl) } : {}),
  }));
  projects = projects.map((project) => ({
    ...project,
    memberIds: [...new Set([
      ...project.memberIds,
      ...groupChats.filter((group) => group.projectId === project.id).flatMap((group) => group.memberIds),
    ])],
  }));
  return {
    version: 7,
    userProfile: normalizeUserProfile(value.userProfile),
    partners,
    conversations: (value.conversations as PrototypeState['conversations']).map((storedConversation) => {
      const seenMessageIds = new Set<string>();
      const conversation = {
        ...storedConversation,
        ...(runtimeModel(storedConversation.runtimeModel) ? { runtimeModel: runtimeModel(storedConversation.runtimeModel) } : {}),
        eventSequences: eventSequences(storedConversation.eventSequences),
        ...(storedConversation.disabledReason === 'partner_root_changed' ? { isDisabled: undefined, disabledReason: undefined } : {}),
        permissionMode: permissionMode(storedConversation.permissionMode, partners.find((item) => item.id === storedConversation.partnerId)?.defaultPermissionMode ?? 'manual'),
        planMode: storedConversation.planMode === 'plan' ? 'plan' as const : 'default' as const,
        codexModel: isCodexModelSelection(storedConversation.codexModel) ? storedConversation.codexModel : undefined,
        messages: storedConversation.messages.map((message, index) => {
          const normalized = { ...message, authorId: normalizeAsteriumUserAuthorId(message.authorId), ...(message.attachments ? { attachments: message.attachments.map(normalizeMessageAttachment).filter((item): item is MessageAttachment => item !== null) } : {}) };
          if (seenMessageIds.has(normalized.id)) {
            let repairedId = `${normalized.id}:duplicate:${index}`;
            let suffix = 1;
            while (seenMessageIds.has(repairedId)) repairedId = `${normalized.id}:duplicate:${index}:${suffix++}`;
            normalized.id = repairedId;
          }
          seenMessageIds.add(normalized.id);
          const quote = normalizeMessageQuote(message.quote);
          if (quote) normalized.quote = quote;
          else delete normalized.quote;
          if (normalized.guidanceState === 'queued') normalized.status = 'failed';
          return message.runState === 'running' || message.isStreaming ? {
          ...normalized,
          runState: 'cancelled' as const,
          isStreaming: false,
          timeline: message.timeline?.map((item) => 'state' in item && item.state === 'running' ? { ...item, state: 'failure' as const } : item),
          } : normalized;
        }),
      };
      const partner = partners.find((item) => item.id === conversation.partnerId);
      if (partner?.sourceMode === 'existing_thread') return { ...conversation, isPrimaryThread: true };
      if (partner?.sourceMode === 'api_partner') return { ...conversation, workspaceGrantIds: conversation.workspaceGrantIds ?? partner.workspaceGrantIds ?? [] };
      if (partner?.sourceMode !== 'local_cli') return conversation;
      if (!partner.partnerRootKind && !partner.partnerRoot && !partner.partnerRootGrantId) return conversation;
      return {
        ...conversation,
        partnerRootKind: conversation.partnerRootKind ?? partner.partnerRootKind ?? 'private',
        partnerRoot: conversation.partnerRoot ?? partner.partnerRoot,
        partnerRootGrantId: conversation.partnerRootGrantId ?? partner.partnerRootGrantId,
        workspaceGrantIds: conversation.workspaceGrantIds ?? partner.workspaceGrantIds ?? [],
      };
    }),
    projects,
    groupChats,
    activePartnerId: text(value.activePartnerId, partners[0]?.id),
    activeConversationId: text(value.activeConversationId),
    activeProjectId: text(value.activeProjectId),
    activeGroupChatId: text(value.activeGroupChatId, groupChats[0]?.id),
  };
}

export function loadPrototypeState(): PrototypeState {
  for (const key of [STATE_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const state = normalizeState(JSON.parse(raw));
      if (state) return state;
    } catch {
      // Invalid local state starts a fresh, empty workspace.
    }
  }
  return createInitialState();
}

export function prepareSingleChatProfile(state: PrototypeState, keepLegacyProjects = false): import('../../shared/singleChatHistory').SingleChatProfile {
  return {
    version: 7,
    activePartnerId: state.activePartnerId, activeConversationId: state.activeConversationId,
    activeProjectId: state.activeProjectId, activeGroupChatId: state.activeGroupChatId,
    userProfile: { ...state.userProfile, id: ASTERIUM_USER_ID },
    partners: state.partners.map((partner) => {
      const safePartner = { ...partner } as Partner & Record<string, unknown>;
      for (const forbidden of ['apiKey', 'auth', 'authentication', 'cookie', 'credential']) delete safePartner[forbidden];
      if (partner.sourceMode === 'local_cli' && partner.codexRuntime) {
        const runtime = { ...partner.codexRuntime };
        delete runtime.executablePath;
        safePartner.codexRuntime = runtime;
      }
      return safePartner as Partner;
    }),
    projects: keepLegacyProjects ? state.projects : [],
    groupChats: state.groupChats.map((groupChat) => ({ ...groupChat, messages: [] })),
  };
}

export function prepareSingleChatMetadata(conversation: PrototypeState['conversations'][number]): import('../../shared/singleChatHistory').SingleChatMetadata {
  const saved = { ...conversation };
  const transient = [
    'messages', 'activeRun', 'workStatus', 'awaitingFirstResponse', 'pendingAuthorization', 'pendingUserInput',
    'runNotice', 'regenerationBackup', 'failedRegenerationClientMessageId', 'lastRunId', 'lastSequence',
  ] as const;
  for (const key of transient) delete (saved as Partial<typeof saved>)[key];
  return saved;
}

export function prepareSingleChatMessage(message: PrototypeState['conversations'][number]['messages'][number]) {
  const saved = { ...message };
  delete saved.isStreaming;
  return saved;
}

export function readLegacySingleChatHistory(): import('../../shared/singleChatHistory').SingleChatHistoryImport {
  const raw = localStorage.getItem(STATE_KEY);
  const state = raw === null ? createInitialState() : normalizeState(JSON.parse(raw));
  if (!state) throw new Error('SINGLE_CHAT_HISTORY_LEGACY_INVALID');
  return {
    profile: prepareSingleChatProfile(state, true),
    conversations: state.conversations.map(conversation => ({
      ...prepareSingleChatMetadata(conversation), messages: conversation.messages.map(prepareSingleChatMessage),
    })),
  };
}

export function restoreSingleChatHistory(history: import('../../shared/singleChatHistory').SingleChatHistorySnapshot): PrototypeState {
  const interrupted = new Set(history.interruptedConversationIds ?? []);
  const state = normalizeState({
    ...history.profile,
    conversations: history.conversations.map(conversation => ({
      ...conversation, messages: restoreSingleChatPageMessages(conversation.partnerId, conversation.messages, interrupted.has(conversation.id)),
    })),
  });
  if (!state) throw new Error('SINGLE_CHAT_HISTORY_INVALID_PROFILE');
  return state;
}

export function restoreSingleChatPageMessages(
  partnerId: string, source: PrototypeState['conversations'][number]['messages'], interrupted: boolean,
): PrototypeState['conversations'][number]['messages'] {
  const messages = source.map(message => {
    if (message.runState === 'running' || message.runState === 'waiting_authorization' || message.runState === 'waiting_user_input') {
      const timeline = (message.timeline ?? []).map(item => 'state' in item && item.state === 'running' ? { ...item, state: 'failure' as const } : item);
      return { ...message, runState: 'cancelled' as const, isStreaming: false, timeline: [
        ...timeline, interruptionNotice(message.id, (timeline.at(-1)?.sequence ?? 0) + 1),
      ] };
    }
    if (message.status !== 'sending') return message;
    return {
      ...message, status: 'failed' as const,
      error: { code: 'SINGLE_CHAT_SEND_UNCERTAIN', message: '退出前的发送结果待确认。', stage: 'transport' as const, retryable: false },
    };
  });
  const user = messages.at(-1);
  if (interrupted && user && normalizeAsteriumUserAuthorId(user.authorId) === ASTERIUM_USER_ID) {
    const id = user.id + ':interrupted';
    messages.push({
      id, authorId: partnerId, content: '', createdAt: user.createdAt,
      runState: 'cancelled', timeline: [interruptionNotice(id, 1)],
    });
  }
  return messages;
}

function interruptionNotice(id: string, sequence: number) {
  return { id: id + ':recovery', sequence, kind: 'status' as const, state: 'failure' as const, summary: '回复中断' };
}

export function savePrototypeState(state: PrototypeState) {
  const safeState: PrototypeState = {
    ...prepareSingleChatProfile(state),
    conversations: state.conversations.map(conversation => ({
      ...prepareSingleChatMetadata(conversation), messages: conversation.messages.map(prepareSingleChatMessage),
    })),
  };
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(safeState));
  } catch (error) {
    console.error('Failed to persist application state.', error);
  }
}

export function loadTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function saveTheme(theme: ThemeMode) {
  localStorage.setItem(THEME_KEY, theme);
}
