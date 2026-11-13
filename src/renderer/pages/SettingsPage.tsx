import { GeneralSettingsView } from '../components/settings/GeneralSettingsView';
import { AboutSettingsView } from '../components/settings/AboutSettingsView';
import { AutomationsView } from '../components/settings/AutomationsView';
import { apiProviderForProtocol } from '../../shared/apiConnections';
import { ApiPartnerConnectionFields } from '../components/settings/ApiPartnerConnectionFields';
import { saveApiPartnerConnection, type ApiConnectionValue } from '../components/settings/apiPartnerConnection';
import { apiSitePreset } from '../../shared/apiPresets';
import { apiEndpoint } from '../../shared/apiEndpoints';
import { AppearanceSettingsView } from '../components/settings/AppearanceSettingsView';
import {
  Clock3, Archive, ArrowLeft, Bot, Brain, Check, ChevronDown, Cloud, Copy, Cpu, Download, FolderOpen, Globe2, KeyRound, Laptop, Link2,
  HardDrive, LockKeyhole, MoonStar, Pencil, Plus, RotateCcw, Save, Server, Settings2,
  ShieldCheck, Sparkles, PlugZap, Trash2, TriangleAlert, Upload, UserRound, UsersRound,
} from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { partnerProfileSeed, usePrototype } from '../app/PrototypeProvider';
import { sanitizePngDataUrl } from '../app/pngDataUrl';
import { formatStudioArchiveMarkdown } from '../app/studioArchiveMarkdown';
import { Avatar } from '../components/ui/Avatar';
import { Modal } from '../components/ui/Modal';
import { AsteriumLogo } from '../components/ui/AsteriumLogo';
import { SkillSettingsView } from '../components/extensions/SkillSettingsView';
import { McpSettingsView } from '../components/extensions/McpSettingsView';
import { MemorySettingsView } from '../components/memory/MemorySettingsView';
import { PARTNER_SETTINGS_NAVIGATION, type PartnerSettingsNavigation } from '../app/partnerSettingsNavigation';
import { COMMON_IMAGE_MIME_TYPES, type CliDetectionResult, type CodexDetectionResult, type CodexRuntimeInfo, type PartnerProfileManagement, type PartnerWorkspaceState, type PermissionMode, type WorkspaceGrant } from '../../shared/agentProtocol';
import { resolveCodexRuntime } from '../../shared/codexRuntimeSelection';
import type { ApiPartner, Conversation, ExistingThreadPartner, GroupChat, LocalCliPartner, Partner, Project, PublicIdentity } from '../types/domain';
import type { ProjectNotebook } from '../../shared/projectNotebook';

type SettingsSection = 'general' | 'automations' | 'appearance' | 'partners' | 'memory' | 'mcp' | 'skills' | 'archives' | 'storage' | 'security' | 'about';
function settingsDestination(pathname: string, search: string): SettingsSection {
  const query = new URLSearchParams(search), section = query.get('section');
  if (section && ['general', 'automations', 'appearance', 'partners', 'memory', 'mcp', 'skills', 'archives', 'storage', 'security', 'about'].includes(section)) return section as SettingsSection;
  return query.has('partner') || pathname.endsWith('/partners') ? 'partners' : 'general';
}

type FormMode = 'existing_thread' | 'local_cli' | 'api_partner';
type IdentityValue = Omit<PublicIdentity, 'avatarDataUrl'>;
type ExistingValue = { serviceType: 'cyberboss_server' | 'cyberboss_local' | 'custom'; serviceUrl: string; auth: string; threadId: string; workspaceRoot: string; tested: boolean };
type LocalValue = { adapterType: 'codex_cli' | 'claude_code'; sessionMode: 'new' | 'resume' };
type ApiValue = ApiConnectionValue & { personality: string; systemPrompt: string; apiSessionHistoryEnabled: boolean; thinkingMode: ApiPartner['thinkingMode']; reasoningEffort: ApiPartner['reasoningEffort']; supportsImageInput: boolean; acceptedMimeTypes: string; maxImageBytes: number; attachmentTransport: 'local_path' | 'native_multimodal' | 'metadata_only' };
type ManagedProfileValue = PartnerProfileManagement & { personalityText: string; systemPrompt: string };

const sourceCopy = {
  existing_thread: { title: '接回现有伙伴', hint: '现有线程 · CyberBoss / 自建服务' },
  local_cli: { title: '邀请本地伙伴', hint: '本地 CLI · Codex / Claude Code' },
  api_partner: { title: '添加新伙伴', hint: 'API · DeepSeek / OpenAI / Anthropic' },
} as const;
const emptyIdentity: IdentityValue = { displayName: '', introduction: '', expertise: '', mentionName: '' };
const emptyExisting: ExistingValue = { serviceType: 'cyberboss_server', serviceUrl: '', auth: '', threadId: '', workspaceRoot: '', tested: false };
const emptyLocal: LocalValue = { adapterType: 'claude_code', sessionMode: 'new' };
const emptyApi: ApiValue = { service: apiSitePreset('preset-deepseek'), provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', apiKey: '', model: '', personality: '', systemPrompt: '', apiSessionHistoryEnabled: true, thinkingMode: 'auto', reasoningEffort: 'high', supportsImageInput: false, acceptedMimeTypes: '', maxImageBytes: 0, attachmentTransport: 'metadata_only' };
const emptyManagedProfile: ManagedProfileValue = { userProfile: false, personality: false, memoryMode: 'self_managed', personalityText: '', systemPrompt: '' };

function isCodexDetectionResult(value: CliDetectionResult | CodexDetectionResult): value is CodexDetectionResult {
  return 'runtimes' in value && Array.isArray(value.runtimes);
}

function applyWorkspaceState(partner: LocalCliPartner | ApiPartner, workspace: PartnerWorkspaceState): LocalCliPartner | ApiPartner {
  if (partner.sourceMode === 'local_cli') return {
    ...partner,
    workspaceVersion: workspace.version,
    partnerRoot: workspace.cwd?.displayPath,
    partnerRootGrantId: workspace.cwd?.grantId,
    workingDirectories: workspace.workspaces.map((grant) => grant.displayPath),
    workspaceGrantIds: workspace.workspaces.map((grant) => grant.grantId),
    activeWorkspaceGrantId: workspace.workspaces.some((grant) => grant.grantId === partner.activeWorkspaceGrantId) ? partner.activeWorkspaceGrantId : workspace.workspaces[0]?.grantId,
    workingDirectory: workspace.workspaces[0]?.displayPath,
    workspaceGrantId: workspace.workspaces[0]?.grantId,
  };
  const grants = [...(workspace.cwd ? [workspace.cwd] : []), ...workspace.workspaces];
  return {
    ...partner,
    workspaceVersion: workspace.version,
    primaryWorkspaceGrantId: workspace.cwd?.grantId,
    workingDirectories: grants.map((grant) => grant.displayPath),
    workspaceGrantIds: grants.map((grant) => grant.grantId),
  };
}

import type { CodexThreadDirectoryPreview, CodexThreadImportPreview } from '../../shared/codexThreadImport';

export function SettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const shortcut = new URLSearchParams(location.search);
  const shortcutPartnerId = shortcut.get('partner') ?? '';
  const { state, refreshProfiles, addPartner, updatePartner, removePartner, trashRemovedPartnerData, createConversation, openImportedConversation, ensureConversation, restoreConversation, deleteConversationPermanently, restoreGroupChat, removeGroupChat, rebindPartnerRoot, theme } = usePrototype();
  const activePartners = state.partners.filter((partner) => !partner.isRemoved);
  const [mode, setMode] = useState<FormMode>('existing_thread');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() => settingsDestination(location.pathname, location.search));
  const [cacheStats, setCacheStats] = useState<{ sizeBytes: number; itemCount: number; limitBytes: number }>();
  const [selectedPartnerId, setSelectedPartnerId] = useState(activePartners[0]?.id ?? '');
  const [editingPartnerId, setEditingPartnerId] = useState<string>();
  const [addingPartner, setAddingPartner] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [mcpDirty, setMcpDirty] = useState(false);
  const [partnerEditEnabled, setPartnerEditEnabled] = useState(false);
  const [discardPromptOpen, setDiscardPromptOpen] = useState(false);
  const pendingDiscardAction = useRef<(() => void) | null>(null);
  const partnerFormRef = useRef<HTMLFormElement>(null);
  const editingRevisionRef = useRef<string | undefined>(undefined);
  const apiFormLoadSequence = useRef(0);
  const sensitiveSaveApprovedRef = useRef(false);
  const [identity, setIdentity] = useState<IdentityValue>(emptyIdentity);
  const [currentAvatar, setCurrentAvatar] = useState<string>();
  const [pendingAvatar, setPendingAvatar] = useState<string>();
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [existing, setExisting] = useState<ExistingValue>(emptyExisting);
  const [existingCredentialRef, setExistingCredentialRef] = useState('');
  const [existingCredentialConfigured, setExistingCredentialConfigured] = useState(false);
  const [local, setLocal] = useState<LocalValue>(emptyLocal);
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<PermissionMode>('manual');
  const [api, setApi] = useState<ApiValue>(emptyApi);
  const [managedProfile, setManagedProfile] = useState<ManagedProfileValue>(emptyManagedProfile);
  const [, setApiCredentialConfigured] = useState(false);
  const [cli, setCli] = useState<CliDetectionResult | CodexDetectionResult>();
  const [selectedCodexRuntimeId, setSelectedCodexRuntimeId] = useState('');
  const [codexThreadDirectory, setCodexThreadDirectory] = useState<CodexThreadDirectoryPreview>();
  const [codexThreadSelectionId, setCodexThreadSelectionId] = useState<string>();
  const codexThreadPreview = codexThreadDirectory?.threads.find(thread => thread.selectionId === codexThreadSelectionId);
  const [pendingCodexImport, setPendingCodexImport] = useState<CodexThreadImportPreview>();
  const [codexImportError, setCodexImportError] = useState('');
  const [selectedClaudeSession, setSelectedClaudeSession] = useState<{ sessionId: string; sessionFilePath: string }>();
  const [threadsBusy, setThreadsBusy] = useState(false);
  const [grants, setGrants] = useState<WorkspaceGrant[]>([]);
  const [partnerRootGrant, setPartnerRootGrant] = useState<WorkspaceGrant>();
  const [activeWorkspaceGrantId, setActiveWorkspaceGrantId] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [avatarError, setAvatarError] = useState('');
  const [savedNotice, setSavedNotice] = useState('');
  const [successPartner, setSuccessPartner] = useState<Partner>();
  const [removeTarget, setRemoveTarget] = useState<Partner>();
  const [purgeTarget, setPurgeTarget] = useState<Conversation>();
  const [purgeGroupTarget, setPurgeGroupTarget] = useState<GroupChat>();
  const [archivedNotebooks, setArchivedNotebooks] = useState<ProjectNotebook[]>([]);
  const [viewGroupTarget, setViewGroupTarget] = useState<GroupChat>();
  const [viewGroupMarkdown, setViewGroupMarkdown] = useState('');
  const [viewGroupBusy, setViewGroupBusy] = useState(false);
  const [viewNotebookTarget, setViewNotebookTarget] = useState<ProjectNotebook>();
  const [purgeNotebookTarget, setPurgeNotebookTarget] = useState<ProjectNotebook>();
  const [purgeAllTarget, setPurgeAllTarget] = useState<'single' | 'group'>();
  const [purgeAllBusy, setPurgeAllBusy] = useState(false);
  const [sensitiveSavePrompt, setSensitiveSavePrompt] = useState<'partner_root' | 'credential'>();
  const [archiveLifecycleBusyId, setArchiveLifecycleBusyId] = useState('');
  const [archiveLifecycleError, setArchiveLifecycleError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const selectedPartner = activePartners.find((partner) => partner.id === selectedPartnerId);
  const editingPartner = activePartners.find((partner) => partner.id === editingPartnerId);
  const purgeBusy = Boolean(purgeTarget && archiveLifecycleBusyId === purgeTarget.id);

  const applyWorkspaceToForm = useCallback((workspace: PartnerWorkspaceState, sourceMode: 'local_cli' | 'api_partner') => {
    if (sourceMode === 'local_cli') {
      setPartnerRootGrant(workspace.cwd);
      const manual = workspace.workspaces.filter((grant) => grant.source !== 'project');
      setGrants(manual);
      setActiveWorkspaceGrantId((current) => manual.some((grant) => grant.grantId === current) ? current : manual[0]?.grantId ?? '');
      return;
    }
    const next = [...(workspace.cwd ? [workspace.cwd] : []), ...workspace.workspaces.filter((grant) => grant.source !== 'project')];
    setGrants(next);
    setActiveWorkspaceGrantId(workspace.cwd?.grantId ?? next[0]?.grantId ?? '');
  }, []);

  useEffect(() => {
    if (settingsSection === 'storage') void window.asteriumArtifacts?.cacheStats().then(setCacheStats);
    if (settingsSection === 'archives') void window.asteriumProjectNotebooks?.listArchived().then(setArchivedNotebooks).catch(() => setArchiveLifecycleError('项目工作笔记归档读取失败。'));
  }, [settingsSection]);

  const clearFileInput = () => { if (fileRef.current) fileRef.current.value = ''; };
  const resetAvatar = (avatar?: string) => {
    setCurrentAvatar(avatar);
    setPendingAvatar(undefined);
    setAvatarRemoved(false);
    setAvatarError('');
    clearFileInput();
  };
  const resetForm = (nextMode: FormMode = 'existing_thread') => {
    apiFormLoadSequence.current++;
    setMode(nextMode);
    setEditingPartnerId(undefined);
    setPartnerEditEnabled(false);
    setIdentity(emptyIdentity);
    setExisting(emptyExisting);
    setExistingCredentialRef('');
    setExistingCredentialConfigured(false);
    setLocal(emptyLocal);
    setDefaultPermissionMode('manual');
    setApi(emptyApi);
    setManagedProfile(nextMode === 'api_partner'
      ? { ...emptyManagedProfile, userProfile: true, personality: true, memoryMode: 'asterium' }
      : nextMode === 'existing_thread' ? { ...emptyManagedProfile, memoryMode: 'none' } : emptyManagedProfile);
    setApiCredentialConfigured(false);
    setCli(undefined);
    setSelectedCodexRuntimeId('');
    setCodexThreadDirectory(undefined);
    setCodexThreadSelectionId(undefined);
    setPendingCodexImport(undefined);
    setSelectedClaudeSession(undefined);
    setGrants([]);
    setPartnerRootGrant(undefined);
    setActiveWorkspaceGrantId('');
    setFormError('');
    setSavedNotice('');
    setSuccessPartner(undefined);
    resetAvatar();
    setFormDirty(false);
  };
  const selectMode = (next: FormMode) => resetForm(next);

  const beginEdit = (partner: Partner) => {
    const apiLoadSequence = ++apiFormLoadSequence.current;
    editingRevisionRef.current = partner.profileRevision;
    setAddingPartner(false);
    setMode(partner.sourceMode);
    setEditingPartnerId(partner.id);
    setPartnerEditEnabled(false);
    setIdentity({
      displayName: partner.publicIdentity.displayName,
      introduction: partner.publicIdentity.introduction,
      expertise: partner.publicIdentity.expertise,
      mentionName: partner.publicIdentity.mentionName,
    });
    resetAvatar(partner.publicIdentity.avatarDataUrl);
    setSuccessPartner(undefined);
    setSavedNotice('');
    setFormError('');
    setFormDirty(false);
    setDefaultPermissionMode(partner.sourceMode === 'local_cli' && partner.adapterType === 'claude_code' && partner.defaultPermissionMode === 'automatic' ? 'manual' : partner.defaultPermissionMode ?? 'manual');
    setManagedProfile({
      userProfile: partner.profileManagement?.userProfile ?? partner.sourceMode === 'api_partner',
      personality: partner.profileManagement?.personality ?? partner.sourceMode === 'api_partner',
      memoryMode: partner.profileManagement?.memoryMode
        ?? (partner.sourceMode === 'api_partner' ? 'asterium' : partner.sourceMode === 'local_cli' ? 'self_managed' : 'none'),
      personalityText: partner.sourceMode === 'api_partner' ? partner.personality : partner.managedPersonality ?? '',
      systemPrompt: partner.sourceMode === 'api_partner' ? partner.systemPrompt ?? '' : partner.managedSystemPrompt ?? '',
    });
    if (partner.sourceMode === 'existing_thread') {
      setExisting({ serviceType: partner.serviceType, serviceUrl: partner.serviceUrl, auth: '', threadId: partner.threadId, workspaceRoot: partner.workspaceRoot ?? '', tested: true });
      setExistingCredentialRef(partner.credentialRef ?? '');
      setExistingCredentialConfigured(partner.configured);
      if (partner.credentialRef && window.asteriumAgents?.bridgeCredentialStatus) {
        void window.asteriumAgents.bridgeCredentialStatus(partner.credentialRef)
          .then((status) => setExistingCredentialConfigured(status.configured))
          .catch(() => setExistingCredentialConfigured(false));
      }
    } else if (partner.sourceMode === 'local_cli') {
      setLocal({ adapterType: partner.adapterType, sessionMode: partner.sessionMode });
      const runtimeIds = partner.workspaceGrantIds ?? [];
      const directories = partner.workingDirectories ?? (partner.workingDirectory ? [partner.workingDirectory] : []);
      const restoredGrants = runtimeIds.map((grantId, index) => ({ grantId, displayPath: directories[index] })).filter((grant): grant is WorkspaceGrant => Boolean(grant.displayPath));
      setGrants(restoredGrants);
      setPartnerRootGrant(partner.partnerRootGrantId && partner.partnerRoot ? { grantId: partner.partnerRootGrantId, displayPath: partner.partnerRoot } : undefined);
      setActiveWorkspaceGrantId(partner.activeWorkspaceGrantId ?? restoredGrants[0]?.grantId ?? '');
      setSelectedClaudeSession(partner.adapterType === 'claude_code' && partner.resumeSessionId && partner.claudeSessionFilePath
        ? { sessionId: partner.resumeSessionId, sessionFilePath: partner.claudeSessionFilePath }
        : undefined);
      setPendingCodexImport(undefined);
      if (partner.adapterType === 'codex_cli' && partner.codexRuntime && partner.codexRuntimeId) {
        setSelectedCodexRuntimeId(partner.codexRuntimeId);
        if (partner.codexRuntime.executablePath) {
          const runtime: CodexRuntimeInfo = { ...partner.codexRuntime, executablePath: partner.codexRuntime.executablePath, runtimeId: partner.codexRuntimeId, installed: true };
          setCli({ installed: true, loggedIn: runtime.loggedIn, version: runtime.version, authMethod: runtime.authMethod, executableLabel: runtime.executableLabel, runtimes: [runtime], recommendedRuntimeId: runtime.runtimeId });
        } else {
          setCli(undefined);
        }
      } else {
        setCli(partner.connectionKind === 'local_claude'
          ? { installed: true, loggedIn: true, version: partner.cliVersion ?? partner.claudeVersion, executableLabel: partner.executableLabel }
          : undefined);
        setSelectedCodexRuntimeId('');
      }
    } else {
      setApi({ modelId: partner.modelId, provider: partner.provider, endpoint: partner.endpoint ?? '', apiKey: '', model: partner.model, personality: partner.personality, systemPrompt: partner.systemPrompt ?? '', apiSessionHistoryEnabled: partner.apiSessionHistoryEnabled, thinkingMode: partner.thinkingMode, reasoningEffort: partner.reasoningEffort, supportsImageInput: partner.attachmentCapabilities?.supportsImageInput ?? false, acceptedMimeTypes: partner.attachmentCapabilities?.acceptedMimeTypes.join(', ') ?? '', maxImageBytes: partner.attachmentCapabilities?.maxImageBytes ?? 0, attachmentTransport: partner.attachmentCapabilities?.attachmentTransport ?? 'metadata_only' });
      const directories = partner.workingDirectories ?? [];
      const restoredGrants = (partner.workspaceGrantIds ?? []).map((grantId, index) => ({ grantId, displayPath: directories[index] })).filter((grant): grant is WorkspaceGrant => Boolean(grant.displayPath));
      setGrants(restoredGrants);
      setActiveWorkspaceGrantId(partner.primaryWorkspaceGrantId ?? restoredGrants[0]?.grantId ?? '');
            setApiCredentialConfigured(partner.configured);
      void window.asteriumAgents?.apiConnectionsGet?.().then(config => {
        if (apiFormLoadSequence.current !== apiLoadSequence) return;
        const binding = config.bindings.find(b => b.partnerId === partner.id);
        const model = config.models.find(m => m.id === binding?.modelId);
        const service = config.services.find(s => s.id === model?.serviceId);
        if (!model || !service) return;
        setApi(current => ({ ...current, modelId: model.id, service, modelConfig: model, selectedCredentialRef: service.credentialRef, provider: service.legacyDeepSeek ? 'deepseek' : apiProviderForProtocol(service.protocol), endpoint: service.endpoint, model: model.model }));
      }).catch(() => undefined);
      if (partner.credentialRef && window.asteriumAgents?.apiCredentialStatus) {
        void window.asteriumAgents.apiCredentialStatus(partner.credentialRef)
          .then((status) => setApiCredentialConfigured(status.configured))
          .catch(() => setApiCredentialConfigured(false));
      }
    }
    if (partner.sourceMode !== 'existing_thread') void window.asteriumAgents?.getPartnerWorkspace?.(partner.id)
      .then((workspace) => { if (workspace.version > 0) applyWorkspaceToForm(workspace, partner.sourceMode); })
      .catch(() => undefined);
  };

  useEffect(() => window.asteriumAgents?.onPartnerProfilesChanged?.((profiles) => {
    if (!editingPartner || partnerEditEnabled || formDirty) return;
    const profile = profiles.partners.find((item) => item.partnerId === editingPartner.id);
    if (!profile) return;
    editingRevisionRef.current = profile.revision;
    setIdentity({
      displayName: profile.publicIdentity.displayName,
      introduction: profile.publicIdentity.introduction,
      expertise: profile.publicIdentity.expertise,
      mentionName: profile.publicIdentity.mentionName,
    });
    setCurrentAvatar(profile.publicIdentity.avatarDataUrl);
    setPendingAvatar(undefined);
    setAvatarRemoved(false);
    setManagedProfile({
      userProfile: profile.management.userProfile,
      personality: profile.management.personality,
      memoryMode: profile.management.memoryMode,
      personalityText: profile.personality ?? '',
      systemPrompt: profile.systemPrompt ?? '',
    });
    if (editingPartner.sourceMode === 'api_partner') {
      setApi((current) => ({ ...current, personality: profile.personality ?? '', systemPrompt: profile.systemPrompt ?? '' }));
    }
  }), [editingPartner, formDirty, partnerEditEnabled]);

  useEffect(() => window.asteriumAgents?.onPartnerWorkspaceChanged?.((workspace) => {
    if (workspace.partnerId === editingPartnerId && mode !== 'existing_thread') applyWorkspaceToForm(workspace, mode);
  }), [applyWorkspaceToForm, editingPartnerId, mode]);

  const requestDiscard = (action: () => void) => {
    if (!formDirty && !mcpDirty) {
      action();
      return;
    }
    pendingDiscardAction.current = action;
    setDiscardPromptOpen(true);
  };
  const closeDiscardPrompt = () => {
    pendingDiscardAction.current = null;
    setDiscardPromptOpen(false);
  };
  const discardAndContinue = () => {
    const action = pendingDiscardAction.current;
    pendingDiscardAction.current = null;
    setDiscardPromptOpen(false);
    setFormDirty(false);
    setMcpDirty(false);
    action?.();
  };
  const openPartner = (partner: Partner) => {
    if (editingPartnerId === partner.id) return;
    requestDiscard(() => {
      setSelectedPartnerId(partner.id);
      beginEdit(partner);
    });
  };
  const applyShortcut = useEffectEvent(() => {
    if (!shortcut.get('section') && !shortcutPartnerId) return;
    const destination = settingsDestination(location.pathname, location.search);
    if (!shortcutPartnerId || destination !== 'partners') { setSettingsSection(destination); return; }
    const target = activePartners.find((partner) => partner.id === shortcutPartnerId);
    if (!target) return;
    setSettingsSection('partners'); setSelectedPartnerId(target.id); beginEdit(target); setPartnerEditEnabled(true);
  });
  useEffect(() => {
    // Hydrate the destination editor after its route mounts; cancel superseded navigation.
    const frame = window.requestAnimationFrame(() => applyShortcut());
    return () => window.cancelAnimationFrame(frame);
  }, [location.key, location.search]);
  const guardShortcut = useEffectEvent((event: Event) => {
    event.preventDefault();
    const { target, from } = (event as CustomEvent<PartnerSettingsNavigation>).detail;
    requestDiscard(() => navigate(target, { state: { from } }));
  });
  useEffect(() => {
    const listener = (event: Event) => guardShortcut(event);
    window.addEventListener(PARTNER_SETTINGS_NAVIGATION, listener);
    return () => window.removeEventListener(PARTNER_SETTINGS_NAVIGATION, listener);
  }, []);
  const startAddingPartner = () => {
    requestDiscard(() => {
      resetForm('existing_thread');
      setAddingPartner(true);
    });
  };

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!formDirty && !mcpDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [formDirty, mcpDirty]);

  const handleAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    setAvatarError('');
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      setAvatarError('请选择不超过 2 MB 的 PNG、JPEG 或 WebP 图片。');
      input.value = '';
      return;
    }
    const reader = new FileReader();
      reader.onload = () => {
      setPendingAvatar(sanitizePngDataUrl(String(reader.result)));
      setAvatarRemoved(false);
      setFormDirty(true);
      input.value = '';
    };
    reader.readAsDataURL(file);
  };

  const detectLocalCli = async () => {
    setBusy(true);
    setFormError('');
    try {
      if (!window.asteriumAgents) throw new Error('仅桌面应用支持本机检测');
      const detector = local.adapterType === 'codex_cli' ? window.asteriumAgents.detectCodex : window.asteriumAgents.detectClaude;
      if (!detector) throw new Error('当前桌面桥接尚未提供所选 CLI 的检测能力');
      const result = await detector();
      setCli(result);
      if (local.adapterType === 'codex_cli' && isCodexDetectionResult(result)) {
        const rememberedEnvironment = editingPartner?.sourceMode === 'local_cli' && editingPartner.adapterType === 'codex_cli'
          ? editingPartner.codexRuntime?.environment
          : undefined;
        const remembered = resolveCodexRuntime(result.runtimes, selectedCodexRuntimeId, rememberedEnvironment);
        setSelectedCodexRuntimeId(remembered?.runtimeId ?? result.recommendedRuntimeId ?? '');
        setPendingCodexImport(undefined);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '检测失败');
    } finally {
      setBusy(false);
    }
  };
  const selectWorkspace = async () => {
    setFormError('');
    try {
      if (!window.asteriumAgents) throw new Error('仅桌面应用支持目录授权');
      const selected = await window.asteriumAgents.selectWorkspace('workspace');
      if (selected) {
        setGrants((current) => current.some((grant) => grant.displayPath === selected.displayPath) ? current : [...current, selected]);
        setActiveWorkspaceGrantId((current) => current || selected.grantId);
        setFormDirty(true);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '目录授权失败');
    }
  };
  const selectPartnerRoot = async () => {
    setFormError('');
    try {
      if (!window.asteriumAgents) throw new Error('仅桌面应用支持目录授权');
      const selected = await window.asteriumAgents.selectWorkspace('partner_root');
      if (!selected) return;
      setPartnerRootGrant(selected);
      setFormDirty(true);
      setSelectedClaudeSession(undefined);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '伙伴配置来源授权失败');
    }
  };
  const loadCodexThread = async () => {
    setThreadsBusy(true);
    setFormError('');
    setCodexThreadDirectory(undefined);
    setCodexThreadSelectionId(undefined);
    setCodexImportError('');
    try {
      const choose = window.asteriumAgents?.chooseCodexThreadDirectory;
      if (!choose) throw new Error('当前桌面桥接尚未提供 Codex 线程导入能力');
      const partner = editingPartner?.sourceMode === 'local_cli' && editingPartner.adapterType === 'codex_cli' ? editingPartner : undefined;
      const runtimeId = selectedCodexRuntimeId || partner?.codexRuntimeId;
      const selectedRuntime = cli && isCodexDetectionResult(cli)
        ? cli.runtimes.find(runtime => runtime.runtimeId === runtimeId) : undefined;
      const runtime = selectedRuntime ?? partner?.codexRuntime;
      if (!runtimeId && !runtime?.environment) throw new Error('请先检测并选择 Codex 运行时。');
      const directory = await choose({ runtimeId, runtimeEnvironment: runtime?.environment, codexHome: runtime?.codexHome || undefined });
      if (directory) setCodexThreadDirectory(directory);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '读取 Codex 线程失败');
    } finally {
      setThreadsBusy(false);
    }
  };

  const openCodexImport = async (preview: CodexThreadImportPreview, partner: Partner) => {
    setThreadsBusy(true);
    setCodexImportError('');
    try {
      const confirm = window.asteriumAgents?.confirmCodexThreadImport;
      if (!confirm) throw new Error('当前桌面桥接尚未提供 Codex 线程导入能力');
      const result = await confirm(preview.selectionId, partner.id, partner.defaultPermissionMode ?? 'manual');
      if (result.kind === 'bound_elsewhere') throw new Error('这条 Codex 线程已绑定工作室或其他会话。');
      openImportedConversation(result.conversation);
      setCodexThreadDirectory(undefined);
      setPendingCodexImport(undefined);
      navigate('/chat');
    } catch (error) {
      setCodexImportError(error instanceof Error ? error.message : '导入 Codex 线程失败');
    } finally {
      setThreadsBusy(false);
    }
  };

  const importClaudeSession = async () => {
    setBusy(true);
    setFormError('');
    try {
      if (!window.asteriumAgents?.importClaudeSession) throw new Error('当前桌面桥接尚未提供 Claude 会话导入能力');
      const imported = await window.asteriumAgents.importClaudeSession();
      if (!imported) return;
      setSelectedClaudeSession({ sessionId: imported.sessionId, sessionFilePath: imported.sessionFilePath });
      setPartnerRootGrant(imported.workspaceGrant);
      setFormDirty(true);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Claude 会话导入失败');
    } finally {
      setBusy(false);
    }
  };
  const testExisting = async () => {
    setFormError('');
    setBusy(true);
    let newlySavedRef = '';
    try {
      if (existing.serviceType !== 'cyberboss_server') throw new Error(existing.serviceType === 'cyberboss_local'
        ? '本地版 CyberBoss 尚未确认桥接接口，当前不能沿用服务器版连接方式。'
        : '自建服务尚未接入，本轮请选择 CyberBoss 服务器版。');
      if (!window.asteriumAgents?.saveBridgeCredential || !window.asteriumAgents.testExistingThread) throw new Error('当前桌面桥接尚未提供 CyberBoss 接入能力。');
      let credentialRef = existingCredentialRef;
      if (existing.auth) {
        const status = await window.asteriumAgents.saveBridgeCredential(existing.auth);
        credentialRef = status.credentialRef;
        newlySavedRef = credentialRef;
      }
      if (!credentialRef) throw new Error('请填写 CyberBoss 认证信息。');
      const status = await window.asteriumAgents.testExistingThread({ serviceUrl: existing.serviceUrl, threadId: existing.threadId, credentialRef });
      if (existingCredentialRef && existingCredentialRef !== credentialRef) await window.asteriumAgents.deleteBridgeCredential?.(existingCredentialRef);
      setExistingCredentialRef(credentialRef);
      setExistingCredentialConfigured(status.configured && status.authenticated);
      setExisting((current) => ({
        ...current,
        auth: '',
        threadId: status.threadId,
        workspaceRoot: status.workspaceRoot ?? '',
        tested: true,
      }));
    } catch (error) {
      if (newlySavedRef) await window.asteriumAgents?.deleteBridgeCredential?.(newlySavedRef).catch(() => undefined);
      const code = error instanceof Error ? error.message : '';
      setExisting((current) => ({ ...current, tested: false }));
      setExistingCredentialConfigured(false);
      setFormError(code.includes('AUTH') ? 'CyberBoss 认证失败，请检查认证信息。'
        : code.includes('THREAD') ? '服务器没有返回可用的当前线程，请先在 CyberBoss 中开启或恢复一个线程。'
          : code.startsWith('请') || code.startsWith('自建') || code.startsWith('当前') ? code : '无法连接 CyberBoss；请确认 Tailscale 已开启，或稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError('');
    setSavedNotice('');
    const displayName = identity.displayName.trim();
    if (!displayName || !identity.mentionName.trim()) return setFormError('请填写显示名称和 @ 名称。');
    if (mode === 'existing_thread' && (!existing.tested || !existingCredentialRef || !existingCredentialConfigured)) return setFormError('请先完成 CyberBoss 真实连接测试。');
    const editingLocal = editingPartner?.sourceMode === 'local_cli' ? editingPartner : undefined;
    const localConnectionChanged = !editingLocal || editingLocal.adapterType !== local.adapterType;
    const localSessionChanged = Boolean(editingLocal && editingLocal.sessionMode !== local.sessionMode);
    const partnerRootChanged = Boolean(editingLocal && (editingLocal.partnerRootGrantId ?? '') !== (partnerRootGrant?.grantId ?? ''));
    const codexRuntimeChanged = Boolean(local.adapterType === 'codex_cli' && selectedCodexRuntimeId && selectedCodexRuntimeId !== editingLocal?.codexRuntimeId);
    const selectedRuntime = local.adapterType === 'codex_cli' && cli && isCodexDetectionResult(cli)
      ? cli.runtimes.find((runtime) => runtime.runtimeId === selectedCodexRuntimeId)
      : undefined;
    if (mode === 'local_cli' && !editingPartner?.isPrototype && local.adapterType === 'codex_cli' && (localConnectionChanged || localSessionChanged || codexRuntimeChanged) && !selectedRuntime?.loggedIn) return setFormError('请先检测并选择已登录的 Codex 运行时。');
    if (mode === 'local_cli' && !editingPartner?.isPrototype && local.adapterType === 'codex_cli' && local.sessionMode === 'resume' && (localConnectionChanged || localSessionChanged || codexRuntimeChanged) && !pendingCodexImport && !editingLocal?.resumeSessionId) return setFormError('请选择要导入的 Codex 线程。');
    if (mode === 'local_cli' && !editingPartner?.isPrototype && local.adapterType === 'claude_code' && (localConnectionChanged || localSessionChanged) && (!cli?.installed || !cli.loggedIn)) return setFormError('请先检测已登录的 Claude Code。');
    if (mode === 'local_cli' && !editingPartner?.isPrototype && local.adapterType === 'claude_code' && local.sessionMode === 'resume' && (localConnectionChanged || localSessionChanged) && !selectedClaudeSession) return setFormError('请选择要导入的 Claude Code session JSONL 文件。');
    if (mode === 'local_cli' && !editingPartner?.isPrototype && !partnerRootGrant) return setFormError('请选择伙伴的主工作区；星丛不会再自动生成默认目录。');
    if (mode === 'local_cli' && local.adapterType === 'claude_code' && defaultPermissionMode === 'automatic') return setFormError('当前尚未确认 Claude 账号与模型支持 auto，请选择其他默认权限。');
    if (mode === 'api_partner' && api.advancedError) return setFormError(api.advancedError);
    if (mode === 'api_partner') { try { apiEndpoint(api.endpoint, api.provider === 'responses' ? 'responses' : api.provider === 'anthropic' ? 'anthropic_messages' : api.provider === 'gemini' ? 'gemini' : 'chat_completions'); } catch { return setFormError('API 地址格式或协议路径不匹配。'); } }
    if (mode === 'api_partner' && (!api.endpoint.trim() || !api.model.trim())) return setFormError('请填写完整 API 端点和模型名称。');
    if (mode === 'api_partner' && api.provider === 'deepseek' && (api.modelConfig?.images ?? api.supportsImageInput)) return setFormError('当前 DeepSeek 适配器尚未实现原生图片输入，请保持“仅元数据”。');
    const sensitiveChanged = Boolean(editingPartner && (
      (mode === 'existing_thread' && existing.auth)
      || (mode === 'api_partner' && api.apiKey)
      || partnerRootChanged
    ));
    if (sensitiveChanged && !sensitiveSaveApprovedRef.current) {
      setSensitiveSavePrompt(partnerRootChanged ? 'partner_root' : 'credential');
      return;
    }
    sensitiveSaveApprovedRef.current = false;

    let apiCredentialRef = api.service ? api.service.credentialRef : api.selectedCredentialRef ?? (editingPartner?.sourceMode === 'api_partner' ? editingPartner.credentialRef : undefined);
    let apiModelId = api.modelId;
    if (mode === 'api_partner' && !editingPartner?.isPrototype) {
      if (!window.asteriumAgents?.saveApiCredential || !window.asteriumAgents.apiCredentialStatus) return setFormError('当前桌面桥接尚未提供系统安全凭据库。');
      setBusy(true);
      try {
        if (api.apiKey) {
          const saved = await window.asteriumAgents.saveApiCredential(api.apiKey);
          apiCredentialRef = saved.credentialRef;
          setApiCredentialConfigured(saved.configured);
        } else if (api.service?.settings?.auth !== 'none' && (!apiCredentialRef || !(await window.asteriumAgents.apiCredentialStatus(apiCredentialRef)).configured)) {
          return setFormError('请填写 API Key。');
        }
        apiModelId = await saveApiPartnerConnection(api, apiCredentialRef || 'none');
      } catch (error) {
        const unavailable = error instanceof Error && error.message.includes('SECURE_STORAGE_UNAVAILABLE');
        if (error instanceof Error && error.message.includes('API_CONFIGURATION_CHANGED')) return setFormError('站点配置已变化，请重新打开伙伴设置后再保存。');
        return setFormError(unavailable ? '系统安全存储当前不可用，已拒绝保存 API Key。' : '连接未保存，请检查模型高级设置；如果站点已被修改，请重新打开伙伴设置。');
      } finally {
        setBusy(false);
      }
    }

    const savedAvatar = pendingAvatar ?? (avatarRemoved ? undefined : currentAvatar);
    const publicIdentity: PublicIdentity = {
      displayName,
      ...(savedAvatar ? { avatarDataUrl: savedAvatar } : {}),
      introduction: identity.introduction.trim(), expertise: identity.expertise.trim(),
      mentionName: identity.mentionName.trim().replace(/^@/, ''),
    };
    const profileManagement: PartnerProfileManagement = mode === 'api_partner'
      ? { userProfile: true, personality: true, memoryMode: 'asterium' }
      : { userProfile: managedProfile.userProfile, personality: managedProfile.personality, memoryMode: mode === 'existing_thread' ? 'none' : managedProfile.memoryMode };
    const base = {
      id: editingPartner?.id ?? `partner-${globalThis.crypto.randomUUID()}`,
      publicIdentity, status: editingPartner?.status ?? 'online' as const,
      createdAt: editingPartner?.createdAt ?? new Date().toISOString(),
      isPrototype: editingPartner?.isPrototype ?? false,
      accent: editingPartner?.accent ?? (mode === 'existing_thread' ? '#67b5a4' : mode === 'local_cli' ? '#6aa5ff' : '#7f8cff'),
      defaultPermissionMode,
      workspaceVersion: editingPartner?.workspaceVersion,
      profileRevision: editingPartner ? editingRevisionRef.current : undefined,
      profileManagement,
      ...(mode !== 'api_partner' ? {
        managedPersonality: managedProfile.personality ? managedProfile.personalityText.trim() : undefined,
        managedSystemPrompt: managedProfile.personality && managedProfile.systemPrompt.trim() ? managedProfile.systemPrompt.trim() : undefined,
      } : {}),
    };
    let partner: Partner;
    if (mode === 'existing_thread') {
      partner = { ...base, attachmentCapabilities: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' }, sourceMode: 'existing_thread', serviceType: existing.serviceType, serviceUrl: existing.serviceUrl.trim(), threadId: existing.threadId.trim(), ...(existing.workspaceRoot ? { workspaceRoot: existing.workspaceRoot } : {}), credentialRef: existingCredentialRef, configured: true, connectionLabel: '现有线程 · CyberBoss 服务器安全桥接', connectionStatus: 'connected', capabilities: { streamingText: true, cancellation: false, toolEvents: false, fileEvents: false, reconnect: true } } satisfies ExistingThreadPartner;
    } else if (mode === 'local_cli') {
      const previous = editingPartner?.sourceMode === 'local_cli' ? editingPartner : undefined;
      const codexRuntime = selectedRuntime ? {
        executablePath: selectedRuntime.executablePath,
        executableLabel: selectedRuntime.executableLabel,
        environment: selectedRuntime.environment,
        environmentLabel: selectedRuntime.environmentLabel,
        codexHome: selectedRuntime.codexHome,
        loggedIn: selectedRuntime.loggedIn,
        version: selectedRuntime.version,
        authMethod: selectedRuntime.authMethod,
      } : undefined;
      partner = {
        ...base, attachmentCapabilities: { supportsImageInput: true, acceptedMimeTypes: [...COMMON_IMAGE_MIME_TYPES], maxImageBytes: 20 * 1024 * 1024, attachmentTransport: 'local_path' }, sourceMode: 'local_cli', adapterType: local.adapterType, location: 'local', sessionMode: local.sessionMode,
        connectionLabel: `本机 ${local.adapterType === 'codex_cli' ? 'Codex' : 'Claude Code'} ${cli?.version ?? previous?.cliVersion ?? previous?.claudeVersion ?? ''}`.trim(),
        connectionKind: local.adapterType === 'codex_cli' ? 'local_codex' : 'local_claude',
        cliVersion: cli?.version ?? previous?.cliVersion ?? previous?.claudeVersion,
        ...(local.adapterType === 'claude_code' ? { claudeVersion: cli?.version ?? previous?.claudeVersion } : {}),
        executableLabel: cli?.executableLabel ?? previous?.executableLabel,
        ...(local.adapterType === 'codex_cli' ? {
          codexRuntimeId: selectedCodexRuntimeId || previous?.codexRuntimeId,
          codexRuntime: codexRuntime ?? previous?.codexRuntime,
          resumeSessionId: local.sessionMode === 'resume' ? previous?.resumeSessionId : undefined,
        } : {
          resumeSessionId: local.sessionMode === 'resume' ? selectedClaudeSession?.sessionId || previous?.resumeSessionId : undefined,
          claudeSessionFilePath: local.sessionMode === 'resume' ? selectedClaudeSession?.sessionFilePath || previous?.claudeSessionFilePath : undefined,
        }),
        partnerRootKind: 'imported',
        partnerRoot: partnerRootGrant?.displayPath,
        partnerRootGrantId: partnerRootGrant?.grantId,
        workingDirectories: grants.map((grant) => grant.displayPath),
        workspaceGrantIds: grants.map((grant) => grant.grantId),
        activeWorkspaceGrantId: grants.some((grant) => grant.grantId === activeWorkspaceGrantId) ? activeWorkspaceGrantId : grants[0]?.grantId,
        workingDirectory: grants[0]?.displayPath,
        workspaceGrantId: grants[0]?.grantId,
        primaryWorkspaceGrantId: undefined,
      } satisfies LocalCliPartner;
    } else {
      partner = {
        ...base,
        sourceMode: 'api_partner',
        provider: api.provider,
        modelId: apiModelId,
        endpoint: api.endpoint.trim(),
        model: api.model.trim(),
        personality: api.personality.trim(),
        systemPrompt: api.systemPrompt.trim() || undefined,
        apiSessionHistoryEnabled: api.apiSessionHistoryEnabled,
        thinkingMode: api.modelConfig?.thinkingMode ?? api.thinkingMode,
        reasoningEffort: api.modelConfig?.reasoningEffort ?? api.reasoningEffort,
        primaryWorkspaceGrantId: grants.some((grant) => grant.grantId === activeWorkspaceGrantId) ? activeWorkspaceGrantId : grants[0]?.grantId,
        workingDirectories: grants.map((grant) => grant.displayPath),
        workspaceGrantIds: grants.map((grant) => grant.grantId),
        credentialRef: apiCredentialRef,
        configured: true,
        attachmentCapabilities: {
          supportsImageInput: api.modelConfig?.images ?? api.supportsImageInput,
          acceptedMimeTypes: api.modelConfig ? api.modelConfig.images ? [...COMMON_IMAGE_MIME_TYPES] : [] : api.acceptedMimeTypes.split(',').map((item) => item.trim().toLocaleLowerCase()).filter(Boolean),
          maxImageBytes: api.modelConfig ? api.modelConfig.images ? 20 * 1024 * 1024 : 0 : api.maxImageBytes,
          attachmentTransport: api.modelConfig ? api.modelConfig.images ? 'native_multimodal' : 'metadata_only' : api.attachmentTransport,
        },
      } satisfies ApiPartner;
    }

    if (!partner.isPrototype && window.asteriumAgents?.savePartnerProfile) {
      setBusy(true);
      try {
        const saved = await window.asteriumAgents.savePartnerProfile(partnerProfileSeed(partner));
        if (saved?.revision) {
          partner.profileRevision = saved.revision;
          editingRevisionRef.current = saved.revision;
        }
      } catch (error) {
        return setFormError(error instanceof Error && error.message.includes('PROFILE_VERSION_CONFLICT')
          ? '磁盘资料已变化，未覆盖外部修改；草稿已保留，请刷新资料并取消编辑后重新打开。'
          : '无法创建或更新伙伴资料目录，伙伴尚未保存。');
      } finally {
        setBusy(false);
      }
    }

    if ((partner.sourceMode === 'local_cli' || partner.sourceMode === 'api_partner') && window.asteriumAgents?.syncPartnerWorkspace) {
      try {
        const workspace = await window.asteriumAgents.syncPartnerWorkspace(
          partner.id,
          partner.sourceMode === 'local_cli' ? partner.partnerRootGrantId : partner.primaryWorkspaceGrantId,
          partner.workspaceGrantIds ?? [],
          editingPartner?.workspaceVersion,
        );
        partner = applyWorkspaceState(partner, workspace);
      } catch (error) {
        return setFormError(error instanceof Error && error.message.includes('PARTNER_WORKSPACE_VERSION_CONFLICT')
          ? '伙伴的实际工作区刚刚发生变化，设置页已经同步；请确认目录后重新保存。'
          : '无法同步伙伴工作区授权，伙伴尚未保存。');
      }
    }

    setApi((current) => ({ ...current, apiKey: '' }));
    setExisting((current) => ({ ...current, auth: '' }));
    resetAvatar(savedAvatar);
    setFormDirty(false);
    if (editingPartner) {
      updatePartner(partner, true);
      if (partnerRootChanged && partner.sourceMode === 'local_cli') rebindPartnerRoot(partner);
      setSelectedPartnerId(partner.id);
      setSavedNotice('修改已保存；已有单聊需显式重读人设，工作室需退出后重新加入。');
      setPartnerEditEnabled(false);
    } else {
      addPartner(partner, true);
      setSelectedPartnerId(partner.id);
      setSuccessPartner(partner);
      if (partner.sourceMode === 'local_cli' && partner.adapterType === 'codex_cli' && pendingCodexImport) {
        void openCodexImport(pendingCodexImport, partner);
      }
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    if (state.conversations.some((conversation) => conversation.partnerId === removeTarget.id && conversation.activeRun)) {
      setFormError('这个伙伴仍有任务在运行，请等待完成后再移除。');
      return;
    }
    if (removeTarget.sourceMode === 'existing_thread' && removeTarget.credentialRef) {
      if (!window.asteriumAgents?.deleteBridgeCredential) return setFormError('当前桌面桥接无法删除 CyberBoss 凭据。');
      try {
        await window.asteriumAgents.deleteBridgeCredential(removeTarget.credentialRef);
      } catch {
        return setFormError('无法删除伙伴的 CyberBoss 凭据，伙伴尚未移除。');
      }
    }
    if (removeTarget.sourceMode === 'local_cli' || removeTarget.sourceMode === 'api_partner') {
      if (window.asteriumAgents?.syncPartnerWorkspace) {
        try {
          await window.asteriumAgents.syncPartnerWorkspace(removeTarget.id, undefined, []);
        } catch {
          return setFormError('无法清理伙伴工作区授权元数据，伙伴尚未移除。');
        }
      }
      const conversationRootGrantIds = state.conversations
        .filter((conversation) => conversation.partnerId === removeTarget.id)
        .map((conversation) => conversation.partnerRootGrantId)
        .filter((grantId): grantId is string => Boolean(grantId));
      const grantIds = [...new Set([
        ...(removeTarget.workspaceGrantIds ?? []),
        ...(removeTarget.sourceMode === 'local_cli' && removeTarget.partnerRootGrantId ? [removeTarget.partnerRootGrantId] : []),
        ...conversationRootGrantIds,
      ])];
      if (grantIds.length && window.asteriumAgents?.revokeWorkspaceGrants) {
        try {
          await window.asteriumAgents.revokeWorkspaceGrants(grantIds);
        } catch {
          return setFormError('无法撤销伙伴的工作区授权，伙伴尚未移除。');
        }
      }
    }
    const next = activePartners.find((partner) => partner.id !== removeTarget.id);
    removePartner(removeTarget.id);
    setSelectedPartnerId(next?.id ?? '');
    setRemoveTarget(undefined);
    resetForm();
  };

  const restoreArchivedConversation = async (conversationId: string) => {
    setArchiveLifecycleBusyId(conversationId);
    setArchiveLifecycleError('');
    const result = await restoreConversation(conversationId);
    setArchiveLifecycleBusyId('');
    if (!result.ok) setArchiveLifecycleError(result.message ?? '恢复失败。');
  };

  const purgeArchivedConversation = async () => {
    if (!purgeTarget) return;
    setArchiveLifecycleBusyId(purgeTarget.id);
    setArchiveLifecycleError('');
    const result = await deleteConversationPermanently(purgeTarget.id);
    setArchiveLifecycleBusyId('');
    if (!result.ok) return setArchiveLifecycleError(result.message ?? '永久删除失败。');
    setPurgeTarget(undefined);
  };

  const purgeAllArchived = async () => {
    if (!purgeAllTarget) return;
    setPurgeAllBusy(true);
    setArchiveLifecycleError('');
    try {
      if (purgeAllTarget === 'single') {
        for (const conversation of state.conversations.filter((item) => item.isArchived)) {
          const result = await deleteConversationPermanently(conversation.id);
          if (!result.ok) throw new Error(result.message ?? `无法删除「${conversation.title}」`);
        }
      } else {
        for (const chat of state.groupChats.filter((item) => item.archivedAt)) await removeGroupChat(chat.id);
      }
      setPurgeAllTarget(undefined);
    } catch (error) {
      setArchiveLifecycleError(error instanceof Error ? error.message : '清空归档失败。');
    } finally {
      setPurgeAllBusy(false);
    }
  };

  const purgeArchivedNotebook = async () => {
    if (!purgeNotebookTarget || !window.asteriumProjectNotebooks) return;
    const busyId = `${purgeNotebookTarget.partnerId}:${purgeNotebookTarget.projectId}`;
    setArchiveLifecycleBusyId(busyId);
    setArchiveLifecycleError('');
    try {
      await window.asteriumProjectNotebooks.purge({ partnerId: purgeNotebookTarget.partnerId, projectId: purgeNotebookTarget.projectId });
      setArchivedNotebooks((current) => current.filter((item) => item.partnerId !== purgeNotebookTarget.partnerId || item.projectId !== purgeNotebookTarget.projectId));
      setPurgeNotebookTarget(undefined);
    } catch {
      setArchiveLifecycleError('项目工作笔记没有永久删除成功。');
    } finally {
      setArchiveLifecycleBusyId('');
    }
  };

  const exportArchivedNotebook = async (notebook: ProjectNotebook) => {
    if (!window.asteriumProjectNotebooks) return;
    const busyId = `${notebook.partnerId}:${notebook.projectId}`;
    setArchiveLifecycleBusyId(busyId);
    setArchiveLifecycleError('');
    try {
      await window.asteriumProjectNotebooks.exportMarkdown({ partnerId: notebook.partnerId, projectId: notebook.projectId });
    } catch {
      setArchiveLifecycleError('项目工作笔记没有导出成功。');
    } finally {
      setArchiveLifecycleBusyId('');
    }
  };

  const openArchivedGroup = async (chat: GroupChat) => {
    setViewGroupTarget(chat);
    setViewGroupMarkdown('');
    setViewGroupBusy(true);
    setArchiveLifecycleError('');
    try {
      const snapshot = await window.asteriumStudio?.getRoom(chat.id);
      if (!snapshot) throw new Error('STUDIO_ROOM_NOT_FOUND');
      setViewGroupMarkdown(formatStudioArchiveMarkdown(snapshot, {
        userId: state.userProfile.id,
        userName: state.userProfile.displayName,
        partners: state.partners.map((partner) => ({ id: partner.id, name: partner.publicIdentity.displayName })),
      }));
    } catch {
      setArchiveLifecycleError('归档群聊记录读取失败。');
    } finally {
      setViewGroupBusy(false);
    }
  };

  const exportArchivedGroup = async () => {
    if (!viewGroupTarget || !viewGroupMarkdown || !window.asteriumStudio?.exportMarkdown) return;
    setViewGroupBusy(true);
    setArchiveLifecycleError('');
    try {
      await window.asteriumStudio.exportMarkdown({ roomId: viewGroupTarget.id, content: viewGroupMarkdown });
    } catch {
      setArchiveLifecycleError('归档群聊记录没有导出成功。');
    } finally {
      setViewGroupBusy(false);
    }
  };

  const openProfileDirectory = async () => {
    setFormError('');
    try {
      if (!window.asteriumAgents?.openProfileDirectory) throw new Error('仅桌面应用支持打开资料目录');
      await window.asteriumAgents.openProfileDirectory();
    } catch {
      setFormError('暂时无法打开伙伴资料目录。');
    }
  };

  return (
    <main className="settings-shell">
      <aside className="glass-panel settings-nav">
        <div className="settings-brand"><AsteriumLogo /><span><strong>Asterium</strong><small>Your AI Companions</small></span></div>
        <button className="back-button" type="button" onClick={() => requestDiscard(() => { const previous = (location.state as { from?: string } | null)?.from; navigate(previous?.startsWith('/') ? previous : '/chat'); })}><ArrowLeft size={18} />返回应用</button>
        <nav aria-label="设置菜单">{[
          [{ id: 'general', label: '通用', Icon: Settings2 }, { id: 'appearance', label: '外观', Icon: MoonStar }],
          [{ id: 'partners', label: '伙伴管理', Icon: UsersRound }, { id: 'memory', label: '记忆', Icon: Brain }, { id: 'automations', label: '自动化', Icon: Clock3 }],
          [{ id: 'mcp', label: 'MCP', Icon: PlugZap }, { id: 'skills', label: 'SKILLS', Icon: PlugZap }, { id: 'security', label: '权限和安全', Icon: LockKeyhole }],
          [{ id: 'archives', label: '归档', Icon: Archive }, { id: 'storage', label: '文件缓存', Icon: HardDrive }],
          [{ id: 'about', label: '关于', Icon: UserRound }],
        ].map((group, index) => <div className="settings-nav-group" key={index}>{group.map(({ id, label, Icon }) => <button key={id} type="button" className={settingsSection === id ? 'active' : ''} onClick={() => { if (settingsSection !== id) requestDiscard(() => setSettingsSection(id as SettingsSection)); }}><Icon size={20} />{label}{id === 'appearance' && <small>{theme === 'light' ? '浅色' : '深色'}</small>}{id === 'archives' && <small>{state.conversations.filter(c => c.isArchived).length + state.groupChats.filter(c => c.archivedAt).length}</small>}</button>)}</div>)}</nav>
      </aside>

      <section className="settings-main glass-panel">
        {settingsSection === 'about' ? <AboutSettingsView /> : settingsSection === 'general' ? <GeneralSettingsView /> : settingsSection === 'automations' ? <AutomationsView /> : settingsSection === 'appearance' ? <AppearanceSettingsView /> : settingsSection === 'skills' ? <SkillSettingsView partners={state.partners} onDirtyChange={setMcpDirty} /> : settingsSection === 'mcp' ? <McpSettingsView partners={state.partners} onDirtyChange={setMcpDirty} /> : settingsSection === 'memory' ? <MemorySettingsView key={location.key} initialPartnerId={shortcutPartnerId} partners={state.partners} conversations={state.conversations} groupChats={state.groupChats} projects={state.projects} onTrashRemovedPartner={trashRemovedPartnerData} /> : settingsSection === 'archives' ? <ArchiveSettingsView conversations={state.conversations.filter((conversation) => conversation.isArchived)} groupChats={state.groupChats.filter((chat) => chat.archivedAt)} notebooks={archivedNotebooks} projects={state.projects} partners={state.partners} busyId={archiveLifecycleBusyId} error={archiveLifecycleError} onRestore={restoreArchivedConversation} onDelete={(conversation) => { setArchiveLifecycleError(''); setPurgeTarget(conversation); }} onRestoreGroup={restoreGroupChat} onOpenGroup={(chat) => void openArchivedGroup(chat)} onDeleteGroup={setPurgeGroupTarget} onOpenNotebook={setViewNotebookTarget} onDeleteNotebook={setPurgeNotebookTarget} onDeleteAll={(kind) => { setArchiveLifecycleError(''); setPurgeAllTarget(kind); }} /> : settingsSection === 'storage' ? <><header className="settings-heading"><div><span><HardDrive size={24} /></span><div><h1>文件缓存</h1><p>远程文件和网络内容只在预览、下载或交付时暂存；项目文件以用户项目目录为准。</p></div></div></header><section className="archive-settings-view"><div className="cache-settings-card"><div><strong>{formatStorage(cacheStats?.sizeBytes ?? 0)}</strong><small>{cacheStats?.itemCount ?? 0} 个共享缓存内容 · 上限 {formatStorage(cacheStats?.limitBytes ?? 1024 * 1024 * 1024)}</small></div><button className="secondary-button" type="button" disabled={!cacheStats?.sizeBytes} onClick={() => void window.asteriumArtifacts?.clearCache().then(setCacheStats)}><Trash2 size={14} />清理缓存</button><p>相同内容只占用一份缓存；清理后不影响已写入项目目录的正式文件，交付记录、文件名和来源仍会保留。</p></div></section></> : settingsSection === 'security' ? <WebSearchSecurityView /> : <>
        <header className="settings-heading"><div><span><UsersRound size={24} /></span><div><h1>伙伴管理</h1><p>接回现有线程、连接本地 CLI，或从零添加 API 伙伴。</p></div></div><div className="settings-heading-actions"><button className="secondary-button" type="button" onClick={() => { void refreshProfiles().then(() => { if (formDirty) setFormError('资料已读取，未保存的草稿已保留；如有冲突，请取消编辑后重新打开。'); }).catch(() => setFormError('资料读取失败，请重试。')); }}>刷新资料</button><button className="secondary-button" type="button" onClick={() => void openProfileDirectory()}><FolderOpen size={16} />打开资料目录</button></div></header>
        <div className="settings-columns">
          <aside className="partner-list-panel">
            <header><h2>伙伴列表</h2><span>{activePartners.length}</span></header>
            <button className="secondary-button add-partner-button" type="button" onClick={startAddingPartner}><Plus size={16} />新增伙伴</button>
            <div className="settings-partner-list">{activePartners.map((partner) => <button className={partner.id === selectedPartnerId && editingPartnerId === partner.id ? 'active' : ''} type="button" key={partner.id} onClick={() => openPartner(partner)}><Avatar partnerId={partner.id} name={partner.publicIdentity.displayName} src={partner.publicIdentity.avatarDataUrl} accent={partner.accent} size="md" status /><span><strong>{partner.publicIdentity.displayName}</strong><small>{sourceCopy[partner.sourceMode].title}{partner.isPrototype ? ' · 演示' : ' · 已连接'}</small></span></button>)}</div>
            {selectedPartner && editingPartnerId === selectedPartner.id && <div className="partner-mini-detail"><span className="status-line"><i />{selectedPartner.isPrototype ? '演示在线' : '已连接'}</span><p>{selectedPartner.publicIdentity.introduction}</p><small>@{selectedPartner.publicIdentity.mentionName} · {sourceDetail(selectedPartner)}</small><div className="mini-detail-actions"><button className="text-button" type="button" onClick={() => setRemoveTarget(selectedPartner)}><Trash2 size={14} />移除</button></div></div>}
          </aside>

          <section className="partner-workflow">
            {addingPartner && <nav className="partner-mode-tabs" aria-label="伙伴接入方式">{(Object.keys(sourceCopy) as FormMode[]).map((source) => <button className={mode === source ? 'active' : ''} type="button" key={source} aria-label={sourceCopy[source].title} onClick={() => requestDiscard(() => { selectMode(source); setAddingPartner(true); })}>{source === 'existing_thread' ? <Link2 size={19} /> : source === 'local_cli' ? <Cpu size={19} /> : <Cloud size={19} />}<span>{sourceCopy[source].title}<small>{sourceCopy[source].hint}</small></span></button>)}</nav>}
            {successPartner ? (
              <div className="success-state"><span className="success-mark"><Check size={34} /></span><Avatar partnerId={successPartner.id} name={successPartner.publicIdentity.displayName} src={successPartner.publicIdentity.avatarDataUrl} accent={successPartner.accent} size="lg" status /><h2>{successPartner.publicIdentity.displayName} 已加入星丛</h2><p>{successDescription(successPartner)}</p>{codexImportError && <p className="form-error" role="alert">{codexImportError}</p>}<div className="success-actions"><button className="primary-button" type="button" disabled={threadsBusy} onClick={() => { if (pendingCodexImport) { void openCodexImport(pendingCodexImport, successPartner); return; } if (successPartner.sourceMode === 'local_cli') createConversation(successPartner.id, undefined, successPartner.sessionMode === 'resume' ? successPartner.resumeSessionId : undefined); else ensureConversation(successPartner.id); navigate('/chat'); }}>去和 TA 聊聊</button><button className="secondary-button" type="button" onClick={() => navigate('/studio/discussion', { state: { openMemberPicker: true } })}>加入工作室</button><button className="text-button" type="button" onClick={() => resetForm(mode)}>继续添加</button></div></div>
            ) : (
              editingPartner || addingPartner ? <form ref={partnerFormRef} className={`partner-form${editingPartner && !partnerEditEnabled ? ' is-readonly' : ''}`} onSubmit={submit} onChange={() => { apiFormLoadSequence.current++; setFormDirty(true); }}>
                <div className="form-scroll" tabIndex={0} aria-label="伙伴资料">
                  <div inert={Boolean(editingPartner) && !partnerEditEnabled ? true : undefined}>
                  {editingPartner && <div className="editing-banner"><Pencil size={16} />{partnerEditEnabled ? `正在编辑 ${editingPartner.publicIdentity.displayName}；保存不会创建重复伙伴。` : `正在查看 ${editingPartner.publicIdentity.displayName}；点击下方“编辑”后可修改。`}</div>}
                  {mode === 'existing_thread' && <ExistingFields value={existing} setValue={setExisting} configured={existingCredentialConfigured} busy={busy} onTest={testExisting} />}
                  {mode === 'local_cli' && <LocalFields value={local} onAdapter={(adapterType) => { setLocal({ adapterType, sessionMode: 'new' }); setCli(undefined); setSelectedCodexRuntimeId(''); setPendingCodexImport(undefined); setSelectedClaudeSession(undefined); setGrants([]); setPartnerRootGrant(undefined); setActiveWorkspaceGrantId(''); setFormDirty(true); }} cli={cli} selectedCodexRuntimeId={selectedCodexRuntimeId} onCodexRuntime={(runtimeId) => { setSelectedCodexRuntimeId(runtimeId); setPendingCodexImport(undefined); setFormDirty(true); }} grants={grants} partnerRootGrant={partnerRootGrant} activeWorkspaceGrantId={activeWorkspaceGrantId} currentDirectories={editingPartner?.sourceMode === 'local_cli' ? editingPartner.workingDirectories ?? (editingPartner.workingDirectory ? [editingPartner.workingDirectory] : []) : []} currentCodexRuntime={editingPartner?.sourceMode === 'local_cli' ? editingPartner.codexRuntime : undefined} busy={busy} threadsBusy={threadsBusy} pendingCodexImport={pendingCodexImport} selectedClaudeSession={selectedClaudeSession} onLoadThread={loadCodexThread} onImportClaudeSession={importClaudeSession} onSessionMode={(sessionMode) => { setLocal((current) => ({ ...current, sessionMode })); setFormDirty(true); if (sessionMode === 'new') { setPendingCodexImport(undefined); setSelectedClaudeSession(undefined); } }} onDetect={detectLocalCli} onPartnerRoot={selectPartnerRoot} onClearPartnerRoot={() => { setPartnerRootGrant(undefined); setFormDirty(true); }} onWorkspace={selectWorkspace} onActiveWorkspace={(grantId) => { setActiveWorkspaceGrantId(grantId); setFormDirty(true); }} onRemove={(grantId) => { if (!editingPartner) void window.asteriumAgents?.revokeWorkspaceGrants?.([grantId]); setGrants((current) => current.filter((grant) => grant.grantId !== grantId)); setActiveWorkspaceGrantId((current) => current === grantId ? grants.find((grant) => grant.grantId !== grantId)?.grantId ?? '' : current); setFormDirty(true); }} />}
                  {mode === 'api_partner' && <ApiFields key={editingPartner?.id ?? 'new-api'} value={api} setValue={setApi} onDirty={() => { apiFormLoadSequence.current++; setFormDirty(true); }} grants={grants} primaryGrantId={activeWorkspaceGrantId} onWorkspace={selectWorkspace} onPrimary={(grantId) => { setActiveWorkspaceGrantId(grantId); setFormDirty(true); }} onRemove={(grantId) => { if (!editingPartner) void window.asteriumAgents?.revokeWorkspaceGrants?.([grantId]); setGrants((current) => current.filter((grant) => grant.grantId !== grantId)); setActiveWorkspaceGrantId((current) => current === grantId ? grants.find((grant) => grant.grantId !== grantId)?.grantId ?? '' : current); setFormDirty(true); }} />}
                  {mode === 'local_cli' && <fieldset className="form-section"><legend>默认权限</legend><p>新对话从这个档位开始；每段对话仍可在输入框旁临时切换，不会改写 Codex 或 Claude Code 的全局与项目配置。</p><label>权限档位<select value={defaultPermissionMode} onChange={(event) => setDefaultPermissionMode(event.target.value as PermissionMode)}><option value="read_only">只读</option><option value="manual">手动审批</option><option value="automatic" disabled={local.adapterType === 'claude_code'}>{local.adapterType === 'claude_code' ? '自动审批（需账号与模型确认支持）' : '自动审批'}</option><option value="full">完整权限</option></select></label></fieldset>}
                  <IdentityFields value={identity} setValue={setIdentity} currentAvatar={currentAvatar} pendingAvatar={pendingAvatar} avatarRemoved={avatarRemoved} fileRef={fileRef} onAvatar={handleAvatar} onCancelPending={() => { setPendingAvatar(undefined); clearFileInput(); }} onRemoveCurrent={() => { setPendingAvatar(undefined); setAvatarRemoved(true); clearFileInput(); }} />
                  {mode !== 'api_partner' && <ManagedProfileFields value={managedProfile} setValue={setManagedProfile} mode={mode} />}
                  {mode === 'api_partner' && <ApiPersonality value={api} setValue={setApi} />}
                  {savedNotice && <p className="form-success">{savedNotice}</p>}
                  </div>
                </div>
                <footer className="form-footer"><p><ShieldCheck size={16} />{boundaryCopy(mode)}</p><div>{editingPartner && <button className="secondary-button" type="button" onClick={() => { if (partnerEditEnabled) beginEdit(editingPartner); else setPartnerEditEnabled(true); }}>{partnerEditEnabled ? '取消编辑' : '编辑'}</button>}{(avatarError || formError) && <span className="form-error">{avatarError || formError}</span>}{(!editingPartner || partnerEditEnabled) && <button className="primary-button" type="submit" disabled={busy}>{busy ? '安全保存中…' : editingPartner ? '保存修改' : mode === 'existing_thread' ? '接回伙伴' : mode === 'local_cli' ? '确认邀请本地伙伴' : '添加 API 伙伴'}</button>}</div></footer>
              </form>
              : <div className="friendly-empty"><UsersRound size={36} /><h2>选择一位伙伴进行管理</h2><p>点击左侧伙伴可直接编辑；只有“新增伙伴”会进入接入方式选择。</p></div>
            )}
          </section>
        </div>
        </>}
      </section>

      {codexThreadDirectory && <Modal title="导入已有线程" onClose={() => { if (!threadsBusy) setCodexThreadDirectory(undefined); }}>
        <div className="modal-body codex-import-body">
          {codexThreadDirectory.threads.length > 0 ? <fieldset className="codex-import-list" disabled={threadsBusy}>
            <legend>{codexThreadDirectory.date} 的线程</legend>
            {codexThreadDirectory.threads.map(thread => <label key={thread.selectionId} className="codex-import-option">
              <input type="radio" name="codex-import-thread" checked={thread.selectionId === codexThreadSelectionId} onChange={() => {
                setCodexThreadSelectionId(thread.selectionId);
                setCodexImportError('');
              }} />
              <span>
                <strong>{thread.title}</strong>
                <small>{thread.updatedAt ? '最后更新 ' + new Date(thread.updatedAt).toLocaleString('zh-CN') : '更新时间未知'}</small>
                <small className="codex-import-cwd" title={thread.cwd}>{thread.cwd}</small>
                {thread.currentRecord && <small>将续接 Codex 当前记录{thread.currentRecord.date ? `（${thread.currentRecord.date}）` : ''}</small>}
                {!thread.directoryAvailable && <small className="codex-import-warning">原目录不可访问，打开后可重新选择。</small>}
              </span>
            </label>)}
          </fieldset> : <p>{codexThreadDirectory.date} 没有可导入的 Codex 线程。</p>}
          {codexThreadDirectory.unavailableCount > 0 && <p className="codex-import-warning">有 {codexThreadDirectory.unavailableCount} 项记录无法确认，暂时无法导入。</p>}
          {codexImportError && <p className="codex-import-warning" role="alert">{codexImportError}</p>}
        </div>
        <footer className="modal-footer">
          <button className="secondary-button" type="button" disabled={threadsBusy} onClick={() => setCodexThreadDirectory(undefined)}>取消</button>
          <button className="primary-button" type="button" disabled={threadsBusy || !codexThreadPreview} onClick={() => {
            if (!codexThreadPreview) return;
            if (editingPartner) void openCodexImport(codexThreadPreview, editingPartner);
            else {
              setPendingCodexImport(codexThreadPreview);
              setCodexThreadDirectory(undefined);
              setLocal(current => ({ ...current, sessionMode: 'resume' }));
              setFormDirty(true);
            }
          }}>{threadsBusy ? '正在导入…' : editingPartner ? '导入并打开' : '确认选择'}</button>
        </footer>
      </Modal>}
      {removeTarget && <Modal title="确认移除伙伴？" description={`将断开并移除 ${removeTarget.publicIdentity.displayName} 的伙伴连接。历史对话仍会保留，可随后一键归档。`} onClose={() => setRemoveTarget(undefined)}><div className="modal-warning modal-warning--danger"><TriangleAlert size={20} /><span><strong>此操作会立即断开伙伴连接</strong><small>不会删除任何外部工作区文件；API 伙伴个人目录也会保留。请确认当前没有仍在进行的任务。</small></span></div>{formError && <p className="form-error">{formError}</p>}<footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setRemoveTarget(undefined)}>取消</button><button className="danger-button" type="button" onClick={() => void confirmRemove()}>确认移除伙伴</button></footer></Modal>}
      {discardPromptOpen && <Modal title="放弃未保存的修改？" description={mcpDirty ? settingsSection === 'skills' ? 'Skill 配置尚未保存。' : 'MCP 配置或凭据输入尚未保存。' : '当前伙伴的修改还没有保存。'} onClose={closeDiscardPrompt}><div className="modal-warning modal-warning--danger"><TriangleAlert size={20} /><span><strong>这些修改会丢失</strong><small>离开当前页面后无法恢复刚才填写或调整的内容。</small></span></div><footer className="modal-footer"><button className="secondary-button" type="button" onClick={closeDiscardPrompt}>继续编辑</button><button className="danger-button" type="button" onClick={discardAndContinue}>放弃修改</button></footer></Modal>}
      {sensitiveSavePrompt && <Modal title={sensitiveSavePrompt === 'partner_root' ? '确认修改伙伴配置来源？' : '确认更新敏感配置？'} description={sensitiveSavePrompt === 'partner_root' ? '配置来源改变后，后续消息会在新目录中使用独立会话。' : '新的认证信息会安全写入系统凭据库。'} onClose={() => setSensitiveSavePrompt(undefined)}><div className="modal-warning"><TriangleAlert size={20} /><span><strong>{sensitiveSavePrompt === 'partner_root' ? '旧会话与原生 session 会完整保留' : '现有认证信息将被替换'}</strong><small>{sensitiveSavePrompt === 'partner_root' ? '星丛会为新目录创建一条新对话；切回原目录后，原会话仍可继续。' : '敏感内容不会写入伙伴资料、对话记录或浏览器存储。'}</small></span></div><footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setSensitiveSavePrompt(undefined)}>取消</button><button className="primary-button" type="button" onClick={() => { setSensitiveSavePrompt(undefined); sensitiveSaveApprovedRef.current = true; partnerFormRef.current?.requestSubmit(); }}>{sensitiveSavePrompt === 'partner_root' ? '确认修改' : '确认更新'}</button></footer></Modal>}
      {purgeTarget && <Modal title="永久删除归档对话？" description="永久删除后无法恢复；这只删除星丛本地记录和相关附件，不会删除 Codex、Claude Code 或其他上游线程。" onClose={() => !purgeBusy && setPurgeTarget(undefined)}><div className="modal-body"><p>将永久删除「{purgeTarget.title}」。</p></div>{archiveLifecycleError && <p className="form-error">{archiveLifecycleError}</p>}<footer className="modal-footer"><button className="secondary-button" type="button" disabled={purgeBusy} onClick={() => setPurgeTarget(undefined)}>取消</button><button className="danger-button" type="button" disabled={purgeBusy} onClick={() => void purgeArchivedConversation()}>{purgeBusy ? '正在删除…' : '永久删除'}</button></footer></Modal>}
      {purgeGroupTarget && <Modal title="永久删除归档群聊？" description="永久删除后无法恢复；只会移除星丛中的群聊入口与群聊记录，不会删除项目、项目文件或伙伴线程。" onClose={() => setPurgeGroupTarget(undefined)}><div className="modal-body"><p>将永久删除「{purgeGroupTarget.name}」。</p></div><footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setPurgeGroupTarget(undefined)}>取消</button><button className="danger-button" type="button" onClick={() => { void removeGroupChat(purgeGroupTarget.id).then(() => setPurgeGroupTarget(undefined)).catch(() => undefined); }}>永久删除</button></footer></Modal>}
      {viewGroupTarget && <Modal size="lg" title={`${viewGroupTarget.name} · 归档群聊`} description="归档群聊仅供查看，不能直接编辑；可导出一份 Markdown 副本。" onClose={() => !viewGroupBusy && setViewGroupTarget(undefined)}><div className="modal-body"><label className="modal-field project-notebook-editor">Markdown<textarea aria-label="归档群聊 Markdown" value={viewGroupMarkdown} readOnly placeholder={viewGroupBusy ? '正在读取归档群聊…' : '没有可显示的群聊记录。'} /></label>{archiveLifecycleError && <p className="form-error">{archiveLifecycleError}</p>}</div><footer className="modal-footer"><button className="secondary-button" type="button" disabled={viewGroupBusy} onClick={() => setViewGroupTarget(undefined)}>关闭</button><button className="primary-button" type="button" disabled={viewGroupBusy || !viewGroupMarkdown || !window.asteriumStudio?.exportMarkdown} onClick={() => void exportArchivedGroup()}><Download size={14} />{viewGroupBusy ? '处理中…' : '导出 Markdown'}</button></footer></Modal>}
      {viewNotebookTarget && <Modal size="lg" title={`${viewNotebookTarget.projectName} · 归档工作笔记`} description="归档笔记仅供查看，不能直接编辑；可导出一份 Markdown 副本。" onClose={() => !archiveLifecycleBusyId && setViewNotebookTarget(undefined)}><div className="modal-body"><label className="modal-field project-notebook-editor">Markdown<textarea aria-label="归档项目工作笔记 Markdown" value={viewNotebookTarget.content} readOnly /></label><small className="project-notebook-revision">r{viewNotebookTarget.revision} · {state.partners.find((item) => item.id === viewNotebookTarget.partnerId)?.publicIdentity.displayName ?? '未知伙伴'} · {new Date(viewNotebookTarget.updatedAt).toLocaleString('zh-CN')}</small>{archiveLifecycleError && <p className="form-error">{archiveLifecycleError}</p>}</div><footer className="modal-footer"><button className="secondary-button" type="button" disabled={Boolean(archiveLifecycleBusyId)} onClick={() => setViewNotebookTarget(undefined)}>关闭</button><button className="primary-button" type="button" disabled={Boolean(archiveLifecycleBusyId)} onClick={() => void exportArchivedNotebook(viewNotebookTarget)}><Download size={14} />{archiveLifecycleBusyId ? '正在导出…' : '导出 Markdown'}</button></footer></Modal>}
      {purgeNotebookTarget && <Modal title="永久删除归档项目工作笔记？" description="这是不可恢复的永久删除，只影响该伙伴在已删除项目中的私有工作笔记。" onClose={() => !archiveLifecycleBusyId && setPurgeNotebookTarget(undefined)}><div className="modal-body"><p>将永久删除「{purgeNotebookTarget.projectName}」中该伙伴的项目工作笔记。</p></div>{archiveLifecycleError && <p className="form-error">{archiveLifecycleError}</p>}<footer className="modal-footer"><button className="secondary-button" type="button" disabled={Boolean(archiveLifecycleBusyId)} onClick={() => setPurgeNotebookTarget(undefined)}>取消</button><button className="danger-button" type="button" disabled={Boolean(archiveLifecycleBusyId)} onClick={() => void purgeArchivedNotebook()}>{archiveLifecycleBusyId ? '正在删除…' : '永久删除'}</button></footer></Modal>}
      {purgeAllTarget && <Modal title={`一键删除全部归档${purgeAllTarget === 'single' ? '对话' : '群聊'}？`} description={purgeAllTarget === 'single' ? '将逐条永久删除全部归档单聊及其本地附件；不会删除上游线程。' : '将永久删除全部归档群聊记录；不会删除项目、项目文件或伙伴线程。'} onClose={() => !purgeAllBusy && setPurgeAllTarget(undefined)}><div className="modal-body"><p>删除后无法恢复，请确认不再需要这些归档记录。</p></div>{archiveLifecycleError && <p className="form-error">{archiveLifecycleError}</p>}<footer className="modal-footer"><button className="secondary-button" type="button" disabled={purgeAllBusy} onClick={() => setPurgeAllTarget(undefined)}>取消</button><button className="danger-button" type="button" disabled={purgeAllBusy} onClick={() => void purgeAllArchived()}>{purgeAllBusy ? '正在删除…' : '全部永久删除'}</button></footer></Modal>}
    </main>
  );
}

function WebSearchSecurityView() {
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void window.asteriumAgents?.webSearchCredentialStatus?.()
      .then((status) => { if (active) setConfigured(status.configured); })
      .catch(() => { if (active) setError('暂时无法读取 Brave Key 状态。'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!apiKey.trim()) return setError('请填写 Brave Search API Key。');
    if (!window.asteriumAgents?.saveWebSearchCredential) return setError('当前桌面桥接尚未提供系统安全凭据库。');
    setBusy(true);
    try {
      const status = await window.asteriumAgents.saveWebSearchCredential(apiKey);
      setConfigured(status.configured);
      setApiKey('');
      setNotice('Brave Key 已安全保存，API 伙伴会优先使用 Brave 搜索。');
    } catch (reason) {
      setError(reason instanceof Error && reason.message.includes('SECURE_STORAGE_UNAVAILABLE') ? '系统安全存储当前不可用，已拒绝保存 Key。' : 'Brave Key 保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.asteriumAgents?.deleteWebSearchCredential) return setError('当前桌面桥接无法移除 Brave Key。');
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.asteriumAgents.deleteWebSearchCredential();
      setConfigured(false);
      setApiKey('');
      setNotice('Brave Key 已移除，API 伙伴仍可使用免 Key 搜索。');
    } catch {
      setError('Brave Key 移除失败。');
    } finally {
      setBusy(false);
    }
  };

  return <>
    <header className="settings-heading"><div><span><LockKeyhole size={24} /></span><div><h1>权限与安全</h1><p>管理 API 伙伴共享的联网凭据；本地伙伴继续使用自己的原生能力。</p></div></div></header>
    <section className="security-settings-view">
      <form className="security-settings-card" onSubmit={save}>
        <div className="security-settings-card__heading"><span><Globe2 size={21} /></span><div><strong>API 伙伴联网搜索</strong><small>免 Key 搜索默认可用</small></div><em>始终开启</em></div>
        <p>有 Brave Key 时优先使用 Brave；未配置或临时失败时，会依次尝试 DuckDuckGo Lite 与 Bing RSS。搜索语言和地区会跟随 query，减少代理出口位置的干扰。这里只影响 API 伙伴。</p>
        <div className="search-provider-flow" aria-label="搜索来源回退顺序"><span className={configured ? 'preferred' : ''}>Brave{configured ? ' · 已配置' : ' · 可选'}</span><i>→</i><span>DuckDuckGo Lite</span><i>→</i><span>Bing RSS</span></div>
        <label>Brave Search API Key（{configured ? '已安全保存；填写后可替换' : '可选'}）<span className="input-with-icon"><KeyRound size={16} /><input type="password" autoComplete="off" value={apiKey} placeholder={configured ? '••••••••' : 'BSA…'} onChange={(event) => setApiKey(event.target.value)} /></span></label>
        <small>Key 只交给 Electron 主进程并写入系统安全凭据库，不进入伙伴资料、对话记录或 localStorage。搜索词会发送给实际使用的搜索服务，打开网页时目标站点会收到请求。</small>
        {notice && <p className="form-success">{notice}</p>}
        {error && <p className="form-error">{error}</p>}
        <footer><button className="primary-button" type="submit" disabled={busy || !apiKey.trim()}>{busy ? '处理中…' : configured ? '更新 Brave Key' : '保存 Brave Key'}</button>{configured && <button className="secondary-button" type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={14} />移除 Key</button>}</footer>
      </form>
    </section>
  </>;
}

function ArchiveSettingsView({ conversations, groupChats, notebooks, projects, partners, busyId, error, onRestore, onDelete, onRestoreGroup, onOpenGroup, onDeleteGroup, onOpenNotebook, onDeleteNotebook, onDeleteAll }: { conversations: Conversation[]; groupChats: GroupChat[]; notebooks: ProjectNotebook[]; projects: Project[]; partners: Partner[]; busyId: string; error: string; onRestore: (conversationId: string) => void; onDelete: (conversation: Conversation) => void; onRestoreGroup: (groupChatId: string) => void; onOpenGroup: (groupChat: GroupChat) => void; onDeleteGroup: (groupChat: GroupChat) => void; onOpenNotebook: (notebook: ProjectNotebook) => void; onDeleteNotebook: (notebook: ProjectNotebook) => void; onDeleteAll: (kind: 'single' | 'group') => void }) {
  const [tab, setTab] = useState<'single' | 'group' | 'notebook'>('single');
  return <>
    <header className="settings-heading"><div><span><Archive size={24} /></span><div><h1>归档管理</h1><p>单聊与群聊分开整理；这里的群聊操作只影响星丛，不会删除项目文件或伙伴原生线程。</p></div></div></header>
    <section className="archive-settings-view">
      <div className="archive-kind-toolbar"><nav className="archive-kind-tabs" aria-label="归档类型"><button className={tab === 'single' ? 'active' : ''} type="button" onClick={() => setTab('single')}>单聊 <small>{conversations.length}</small></button><button className={tab === 'group' ? 'active' : ''} type="button" onClick={() => setTab('group')}>群聊 <small>{groupChats.length}</small></button><button className={tab === 'notebook' ? 'active' : ''} type="button" onClick={() => setTab('notebook')}>项目工作笔记 <small>{notebooks.length}</small></button></nav>{tab !== 'notebook' && <button className="text-button archive-delete-all" type="button" disabled={tab === 'single' ? !conversations.length : !groupChats.length} onClick={() => onDeleteAll(tab)}><Trash2 size={14} />一键删除全部</button>}</div>
      {error && <p className="form-error">{error}</p>}
      {tab === 'single' ? conversations.length ? <div className="archive-conversation-list">{conversations.map((conversation) => { const partner = partners.find((item) => item.id === conversation.partnerId); const busy = busyId === conversation.id; return <article key={conversation.id}><Avatar partnerId={partner?.id} name={partner?.publicIdentity.displayName ?? '伙伴'} src={partner?.publicIdentity.avatarDataUrl} accent={partner?.accent} size="sm" /><span><strong>{conversation.title}</strong><small>{partner?.publicIdentity.displayName ?? '未知伙伴'}{partner?.isRemoved ? ' · 伙伴已移除' : ''}{conversation.nativeThreadState === 'archived' ? ' · 原生线程已归档' : ''} · {conversation.archivedAt ? new Date(conversation.archivedAt).toLocaleString('zh-CN') : '归档时间未知'}</small></span><button className="secondary-button" type="button" disabled={busy} onClick={() => onRestore(conversation.id)}><RotateCcw size={14} />{busy ? '处理中…' : '恢复'}</button><button className="text-button archive-delete-button" type="button" disabled={busy} onClick={() => onDelete(conversation)}><Trash2 size={14} />永久删除</button></article>; })}</div> : <div className="friendly-empty"><Archive size={36} /><h2>还没有归档单聊</h2><p>在单聊页归档的对话会集中放在这里。</p></div>
        : tab === 'group' ? groupChats.length ? <div className="archive-conversation-list">{groupChats.map((chat) => { const project = projects.find((item) => item.id === chat.projectId); return <article key={chat.id}><Avatar name={project?.name ?? '项目'} src={project?.avatarDataUrl} accent="#7897c9" size="sm" /><span><strong>{chat.name}</strong><small>{chat.projectDeletedAt ? '项目已删除 · 只读归档' : project?.name ?? '项目暂不可用'} · {chat.archivedAt ? new Date(chat.archivedAt).toLocaleString('zh-CN') : '归档时间未知'}</small></span><button className="secondary-button" type="button" onClick={() => onOpenGroup(chat)}>查看</button>{!chat.projectDeletedAt && <button className="secondary-button" type="button" onClick={() => onRestoreGroup(chat.id)}><RotateCcw size={14} />恢复</button>}<button className="text-button archive-delete-button" type="button" onClick={() => onDeleteGroup(chat)}><Trash2 size={14} />永久删除</button></article>; })}</div> : <div className="friendly-empty"><Archive size={36} /><h2>还没有归档群聊</h2><p>在工作室归档的群聊会集中放在这里。</p></div>
          : notebooks.length ? <div className="archive-conversation-list">{notebooks.map((notebook) => { const partner = partners.find((item) => item.id === notebook.partnerId); const busy = busyId === `${notebook.partnerId}:${notebook.projectId}`; return <article key={`${notebook.partnerId}:${notebook.projectId}`}><Avatar partnerId={partner?.id} name={partner?.publicIdentity.displayName ?? '伙伴'} src={partner?.publicIdentity.avatarDataUrl} accent={partner?.accent} size="sm" /><span><strong>{notebook.projectName}</strong><small>{partner?.publicIdentity.displayName ?? '未知伙伴'} · {notebook.archivedAt ? new Date(notebook.archivedAt).toLocaleString('zh-CN') : '归档时间未知'} · r{notebook.revision}</small></span><button className="secondary-button" type="button" disabled={busy} onClick={() => onOpenNotebook(notebook)}>查看</button><button className="text-button archive-delete-button" type="button" disabled={busy} onClick={() => onDeleteNotebook(notebook)}><Trash2 size={14} />永久删除</button></article>; })}</div> : <div className="friendly-empty"><Archive size={36} /><h2>还没有归档项目工作笔记</h2><p>删除项目后，伙伴的私有项目工作笔记会保留在这里。</p></div>}
    </section>
  </>;
}

function formatStorage(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function ExistingFields({ value, setValue, configured, busy, onTest }: { value: ExistingValue; setValue: React.Dispatch<React.SetStateAction<ExistingValue>>; configured: boolean; busy: boolean; onTest: () => void }) {
  const selectService = (serviceType: ExistingValue['serviceType']) => setValue((current) => ({
    ...current,
    serviceType,
    serviceUrl: serviceType === 'cyberboss_server' ? emptyExisting.serviceUrl : '',
    threadId: serviceType === 'cyberboss_server' ? emptyExisting.threadId : '',
    workspaceRoot: '',
    auth: '',
    tested: false,
  }));
  const server = value.serviceType === 'cyberboss_server';
  return <fieldset className="form-section"><legend>已有服务或线程</legend><p>接回原服务里的既有线程，不新建替代伙伴，也不复制或修改其人格、记忆、Skills、MCP 和配置。</p><div className="model-grid"><label>服务类型<select value={value.serviceType} onChange={(event) => selectService(event.target.value as ExistingValue['serviceType'])}><option value="cyberboss_server">CyberBoss（服务器版）</option><option value="cyberboss_local">CyberBoss（本地版）</option><option value="gemini" disabled>Gemini（请在 API 伙伴中配置）</option><option value="custom" disabled>自建服务（尚未接入）</option></select></label>{server && <label>服务地址<input type="url" value={value.serviceUrl} placeholder="https://your-cyberboss.example.com" onChange={(event) => setValue((current) => ({ ...current, serviceUrl: event.target.value, threadId: '', workspaceRoot: '', tested: false }))} /></label>}{server && <label>认证信息（{configured ? '已安全保存；留空保持不变' : '保存到系统安全凭据库'}）<span className="input-with-icon"><KeyRound size={16} /><input type="password" autoComplete="off" value={value.auth} placeholder={configured ? '••••••••' : ''} onChange={(event) => setValue((current) => ({ ...current, auth: event.target.value, tested: false }))} /></span></label>}{server && <label>当前线程 ID<input value={value.threadId} readOnly /><button className="secondary-button" type="button" disabled={!value.threadId} onClick={() => void navigator.clipboard.writeText(value.threadId)}><Copy size={14} />复制线程 ID</button></label>}{server && value.workspaceRoot && <label>服务器工作区<input value={value.workspaceRoot} readOnly /></label>}</div>{server ? <><div className="existing-thread-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onTest}>{busy ? '正在连接…' : value.tested ? '刷新当前线程' : '测试真实连接'}</button></div>{value.tested && <small>星丛会动态跟随 CyberBoss 当前活跃线程；/new 后将自动刷新 thread ID。当前桥接暂不支持远程取消、工具和文件明细。</small>}</> : <div className="connection-variant-note"><strong>本地版暂不能直接套用服务器版连接</strong><small>服务器版使用 Tailscale HTTPS、Cookie 认证和 SSE；本地版必须先确认本机 CyberBoss 是否提供兼容 Web sidecar、监听地址与认证方式。若只是连接本机 Claude Code 或 Codex，请使用“邀请本地伙伴”。</small></div>}</fieldset>;
}

function LocalFields({ value, onAdapter, cli, selectedCodexRuntimeId, onCodexRuntime, grants, partnerRootGrant, activeWorkspaceGrantId, currentDirectories, currentCodexRuntime, busy, threadsBusy, pendingCodexImport, selectedClaudeSession, onLoadThread, onImportClaudeSession, onSessionMode, onDetect, onPartnerRoot, onClearPartnerRoot, onWorkspace, onActiveWorkspace, onRemove }: {
  value: LocalValue;
  onAdapter: (adapterType: LocalValue['adapterType']) => void;
  cli?: CliDetectionResult | CodexDetectionResult;
  selectedCodexRuntimeId: string;
  onCodexRuntime: (runtimeId: string) => void;
  grants: WorkspaceGrant[];
  partnerRootGrant?: WorkspaceGrant;
  activeWorkspaceGrantId: string;
  currentDirectories: string[];
  currentCodexRuntime?: LocalCliPartner['codexRuntime'];
  busy: boolean;
  threadsBusy: boolean;
  pendingCodexImport?: CodexThreadImportPreview;
  selectedClaudeSession?: { sessionId: string; sessionFilePath: string };
  onLoadThread: () => void;
  onImportClaudeSession: () => void;
  onSessionMode: (sessionMode: LocalValue['sessionMode']) => void;
  onDetect: () => void;
  onPartnerRoot: () => void;
  onClearPartnerRoot: () => void;
  onWorkspace: () => void;
  onActiveWorkspace: (grantId: string) => void;
  onRemove: (grantId: string) => void;
}) {
  const codexDetection = cli && isCodexDetectionResult(cli) ? cli : undefined;
  const selectedCodexRuntime = codexDetection?.runtimes.find((runtime) => runtime.runtimeId === selectedCodexRuntimeId);
  const cliName = value.adapterType === 'codex_cli' ? 'Codex' : 'Claude Code';
  const displayedVersion = selectedCodexRuntime?.version ?? cli?.version ?? '';
  const displayedLoggedIn = selectedCodexRuntime?.loggedIn ?? cli?.loggedIn;
  const displayedAuthMethod = selectedCodexRuntime?.authMethod ?? cli?.authMethod;
  const displayedError = selectedCodexRuntime?.error ?? cli?.error;
  return <>
    <fieldset className="form-section">
      <legend>本地 CLI</legend>
      <p>沿用 CLI 已有账号、人格、记忆、Skills、MCP 和配置，星丛不会重复设置。</p>
      <div className="choice-row">
        <Choice active={value.adapterType === 'claude_code'} icon={<Bot />} title="Claude Code" onClick={() => onAdapter('claude_code')} />
        <Choice active={value.adapterType === 'codex_cli'} icon={<Sparkles />} title="Codex" onClick={() => onAdapter('codex_cli')} />
      </div>
      <div className="capability-summary">
        {value.adapterType === 'codex_cli' ? <Server size={20} /> : <Laptop size={20} />}
        <div>
          <strong>{cli ? (cli.installed ? `${cliName} ${displayedVersion}` : `未找到 ${cliName}`) : `检测本机 ${cliName}`}</strong>
          <p>{displayedLoggedIn ? `已登录 · ${displayedAuthMethod ?? '现有认证'}` : displayedError?.message ?? '请检测 CLI 与登录状态'}</p>
          <button className="secondary-button" type="button" disabled={busy} onClick={onDetect}>{busy ? '检测中…' : cli ? '重新检测 CLI 与登录状态' : '检测 CLI 与登录状态'}</button>
        </div>
      </div>
      {value.adapterType === 'codex_cli' && codexDetection?.runtimes.length ? <div className="codex-runtime-list" aria-label="Codex 运行时列表">
        <div className="runtime-list-heading"><strong>选择 Codex 运行时</strong><small>默认推荐全局 CLI，但最终由你选择。</small></div>
        {codexDetection.runtimes.map((runtime) => <button className={runtime.runtimeId === selectedCodexRuntimeId ? 'active' : ''} type="button" key={runtime.runtimeId} onClick={() => onCodexRuntime(runtime.runtimeId)} aria-label={`选择 Codex 运行时 ${runtime.environmentLabel} ${runtime.version ?? ''}`}>
          <span className="runtime-title"><strong>{runtime.environmentLabel} · {runtime.version ?? '版本未知'}</strong>{runtime.runtimeId === codexDetection.recommendedRuntimeId && <small>推荐</small>}</span>
          <code>{runtime.executablePath}</code>
          <span>认证：{runtime.loggedIn ? `已登录 · ${runtime.authMethod ?? '现有认证'}` : runtime.error?.message ?? '未登录'}</span>
          <span>CODEX_HOME：<code>{runtime.codexHome}</code></span>
        </button>)}
      </div> : value.adapterType === 'codex_cli' && currentCodexRuntime ? <div className="workspace-regrant"><strong>上次选择：{currentCodexRuntime.environmentLabel} · {currentCodexRuntime.version}</strong>{currentCodexRuntime.executablePath && <small>{currentCodexRuntime.executablePath}</small>}<small>发送时会自动重新核验这个运行时；也可以手动重新检测并更换。</small></div> : null}
    </fieldset>
    <fieldset className="form-section">
      <legend>伙伴配置来源与会话</legend>
      <p>请选择本地伙伴唯一的主工作区（cwd）。伙伴会从这里启动，并继续使用目录中原有的 Claude / Codex 配置、Skills 与 MCP；星丛不会自动创建替代目录。</p>
      <div className="partner-root-field">
        <span><strong>{partnerRootGrant ? partnerRootGrant.displayPath : '尚未选择主工作区'}</strong><small>{partnerRootGrant ? '固定作为 cwd；创建与恢复会话都从这里启动。' : '保存伙伴前必须选择。'}</small></span>
        <div><button className="secondary-button" type="button" onClick={onPartnerRoot}>{partnerRootGrant ? '更改来源' : '导入配置来源'}</button>{partnerRootGrant && <button className="text-button" type="button" onClick={onClearPartnerRoot}>清除选择</button>}</div>
      </div>
      <div className="choice-row">
        <Choice active={value.sessionMode === 'new'} icon={<Plus />} title={value.adapterType === 'codex_cli' ? '开启新线程' : '开启新会话'} onClick={() => onSessionMode('new')} />
        <Choice active={value.sessionMode === 'resume'} icon={<Save />} title={value.adapterType === 'codex_cli' ? '导入已有线程' : '导入已有会话'} onClick={() => { if (value.adapterType === 'codex_cli') { if (!threadsBusy) onLoadThread(); } else onSessionMode('resume'); }} />
      </div>
      {value.adapterType === 'codex_cli' && value.sessionMode === 'new' && <div className="thread-mode-note"><strong>将打开新的对话窗口</strong><small>第一次发送消息时创建新的 Codex thread；后续消息自动续接。</small></div>}
      {pendingCodexImport && value.adapterType === 'codex_cli' && <small>已选择 {pendingCodexImport.title}</small>}
      {value.adapterType === 'claude_code' && value.sessionMode === 'resume' && <div className="codex-thread-picker">
        <button className="secondary-button" type="button" disabled={busy} onClick={onImportClaudeSession}>{busy ? '读取会话中…' : '选择 Claude session JSONL'}</button>
        {selectedClaudeSession
          ? <div className="workspace-regrant"><strong>已选择会话 {selectedClaudeSession.sessionId}</strong><small>{selectedClaudeSession.sessionFilePath}</small><small>会话原工作目录已固定为伙伴配置来源。</small></div>
          : <small>将打开 Claude Code 的 projects 文件夹；请选择希望续接的 `.jsonl` 会话文件。</small>}
      </div>}
    </fieldset>
    <fieldset className="form-section">
      <legend>额外工作区</legend>
      <p>这些目录只扩大伙伴可访问范围。添加、移除或切换都不会改变 partnerRoot、人格、MCP 或已经绑定的对话。</p>
      <button className="secondary-button" type="button" onClick={onWorkspace}><Plus size={16} />添加工作区</button>
      {grants.length ? <div className="workspace-grant-list">{grants.map((grant) => <div key={grant.grantId}><button className={grant.grantId === activeWorkspaceGrantId ? 'active' : ''} type="button" onClick={() => onActiveWorkspace(grant.grantId)} aria-label={`切换到工作区 ${grant.displayPath}`}><span><strong>{grant.displayPath}</strong><small>{grant.grantId === activeWorkspaceGrantId ? '当前工作区 · 不改变伙伴启动目录' : '已授权工作区'}</small></span>{grant.grantId === activeWorkspaceGrantId && <Check size={15} />}</button><button className="icon-button" type="button" onClick={() => onRemove(grant.grantId)} aria-label={`移除授权工作区 ${grant.displayPath}`}><Trash2 size={15} /></button></div>)}</div> : currentDirectories.length ? <div className="workspace-regrant"><strong>旧版本保存的额外目录（需重新授权一次）</strong>{currentDirectories.map((directory) => <small key={directory}>{directory}</small>)}</div> : <small>暂未添加额外工作区；伙伴仍可在自己的 partnerRoot 中工作。</small>}
    </fieldset>
  </>;
}

function ApiFields({ value, setValue, onDirty, grants, primaryGrantId, onWorkspace, onPrimary, onRemove }: { value: ApiValue; setValue: React.Dispatch<React.SetStateAction<ApiValue>>; onDirty: () => void; grants: WorkspaceGrant[]; primaryGrantId: string; onWorkspace: () => void; onPrimary: (grantId: string) => void; onRemove: (grantId: string) => void }) {
  return <>
    <ApiPartnerConnectionFields value={value} onDirty={onDirty} onChange={next => setValue(current => ({ ...current, ...next }))} />
    <fieldset className="form-section"><legend>Agent 工作目录</legend><p>第一个选中的目录作为主目录；相对路径从这里解析。其余目录仅扩大文件工具的授权范围。</p><button className="secondary-button" type="button" onClick={onWorkspace}><Plus size={16} />添加工作目录</button>{grants.length ? <div className="workspace-grant-list">{grants.map((grant) => <div key={grant.grantId}><button className={grant.grantId === primaryGrantId ? 'active' : ''} type="button" onClick={() => onPrimary(grant.grantId)} aria-label={`设为主工作目录 ${grant.displayPath}`}><span><strong>{grant.displayPath}</strong><small>{grant.grantId === primaryGrantId ? '主工作目录' : '附加授权目录'}</small></span>{grant.grantId === primaryGrantId && <Check size={15} />}</button><button className="icon-button" type="button" onClick={() => onRemove(grant.grantId)} aria-label={`移除工作目录 ${grant.displayPath}`}><Trash2 size={15} /></button></div>)}</div> : <div className="connection-variant-note"><strong>尚未配置工作目录</strong><small>普通聊天和思考内容仍然可用；文件、终端和交付工具暂不提供给伙伴。</small></div>}<small>读文件、列目录和搜索可自动执行；写入、编辑、删除与 PowerShell 命令都会逐次请求确认。命令本身不受工作区沙箱限制。</small></fieldset>
  </>;
}

function IdentityFields({ value, setValue, currentAvatar, pendingAvatar, avatarRemoved, fileRef, onAvatar, onCancelPending, onRemoveCurrent }: { value: IdentityValue; setValue: React.Dispatch<React.SetStateAction<IdentityValue>>; currentAvatar?: string; pendingAvatar?: string; avatarRemoved: boolean; fileRef: React.RefObject<HTMLInputElement | null>; onAvatar: (event: ChangeEvent<HTMLInputElement>) => void; onCancelPending: () => void; onRemoveCurrent: () => void }) {
  const shownCurrent = currentAvatar && !avatarRemoved;
  return <fieldset className="form-section identity-section"><legend>公开身份资料</legend><p>名字、介绍与长期擅长写入可见的伙伴资料目录，供单聊和工作室共同识别。</p><div className="identity-grid"><label><span className="field-label">显示名称 <i>*</i></span><input value={value.displayName} onChange={(event) => setValue((current) => ({ ...current, displayName: event.target.value }))} /></label><div className="avatar-uploader"><input ref={fileRef} type="file" aria-label="选择头像文件" accept="image/png,image/jpeg,image/webp" onChange={onAvatar} hidden />{pendingAvatar ? <><span>待保存预览</span><Avatar name={value.displayName || '预览'} src={pendingAvatar} size="sm" /><div><button type="button" onClick={() => fileRef.current?.click()}>重新选择</button><button type="button" onClick={onCancelPending}>取消更换</button></div></> : shownCurrent ? <><span>当前头像</span><Avatar name={value.displayName || '当前头像'} src={currentAvatar} size="sm" /><div><button type="button" onClick={() => fileRef.current?.click()}>更换头像</button><button type="button" onClick={onRemoveCurrent}>移除头像</button></div></> : <><span>{avatarRemoved ? '保存后移除当前头像' : '头像（可选）'}</span><button type="button" onClick={() => fileRef.current?.click()}><Upload size={18} />选择头像</button></>}</div></div><label>简短身份介绍<input value={value.introduction} onChange={(event) => setValue((current) => ({ ...current, introduction: event.target.value }))} /></label><div className="model-grid"><label>擅长能力 / 团队职责<input value={value.expertise} onChange={(event) => setValue((current) => ({ ...current, expertise: event.target.value }))} /></label><label><span className="field-label">称呼或 @ 名称 <i>*</i></span><input aria-label="称呼或 @ 名称" value={value.mentionName} onChange={(event) => setValue((current) => ({ ...current, mentionName: event.target.value }))} /></label></div></fieldset>;
}

function ManagedProfileFields({ value, setValue, mode }: { value: ManagedProfileValue; setValue: React.Dispatch<React.SetStateAction<ManagedProfileValue>>; mode: Exclude<FormMode, 'api_partner'> }) {
  return <fieldset className="form-section memory-section"><legend>星丛资料代管</legend><p>用户资料与伙伴设定由主进程受限服务维护，不会作为普通工作区开放。</p><div className="managed-toggle-row"><ManagedToggle title="向该伙伴提供用户资料" detail="认识当前用户" checked={value.userProfile} onChange={(checked) => setValue((current) => ({ ...current, userProfile: checked }))} /><ManagedToggle title="由星丛管理伙伴设定" detail="托管 persona.md" checked={value.personality} onChange={(checked) => setValue((current) => ({ ...current, personality: checked }))} /></div>{mode === 'local_cli' ? <label>记忆管理方式<select aria-label="记忆管理方式" value={value.memoryMode} onChange={(event) => setValue((current) => ({ ...current, memoryMode: event.target.value as 'self_managed' | 'asterium' }))}><option value="self_managed">伙伴自己管理</option><option value="asterium">由星丛管理</option></select><small>{value.memoryMode === 'asterium' ? '后续由星丛提供内置记忆工具、简报和注入。' : '星丛不提供内置记忆工具、简报或记忆注入。'}</small></label> : <div className="connection-variant-note"><strong>记忆由现有伙伴自行管理</strong><small>接回伙伴不接入星丛内置记忆系统。</small></div>}{value.personality && <><label>性格与相处方式<textarea value={value.personalityText} onChange={(event) => setValue((current) => ({ ...current, personalityText: event.target.value }))} rows={4} /></label><details><summary>稳定指令（高级选项）<ChevronDown size={17} /></summary><label>稳定指令<textarea value={value.systemPrompt} onChange={(event) => setValue((current) => ({ ...current, systemPrompt: event.target.value }))} rows={5} /></label></details></>}</fieldset>;
}

function ManagedToggle({ title, detail, checked, onChange }: { title: string; detail: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className={`managed-toggle${checked ? ' is-active' : ''}`}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span><strong>{title}</strong><small>{detail}</small></span><span className="managed-toggle-mark" aria-hidden="true"><Check size={12} /></span></label>;
}

function ApiPersonality({ value, setValue }: { value: ApiValue; setValue: React.Dispatch<React.SetStateAction<ApiValue>> }) {
  return <><fieldset className="form-section api-personality"><legend>性格与相处方式</legend><label>性格与相处方式<textarea value={value.personality} onChange={(event) => setValue((current) => ({ ...current, personality: event.target.value }))} rows={4} /></label><details><summary>系统 Prompt（高级选项）<ChevronDown size={17} /></summary><label>稳定指令<textarea value={value.systemPrompt} onChange={(event) => setValue((current) => ({ ...current, systemPrompt: event.target.value }))} rows={5} /></label></details></fieldset><fieldset className="form-section memory-section"><legend>记忆与会话连续性</legend><div className="connection-variant-note"><strong>长期记忆由星丛管理</strong><small>API 伙伴固定接入星丛内置记忆系统，并默认保留同一会话的运行记录。</small></div></fieldset></>;
}

function Choice({ active, icon, title, onClick }: { active: boolean; icon: ReactNode; title: string; onClick: () => void }) { return <button className={`choice-card ${active ? 'active' : ''}`} type="button" onClick={onClick}>{icon}<span>{title}</span>{active && <Check size={16} />}</button>; }
function sourceDetail(partner: Partner) { return partner.sourceMode === 'api_partner' ? `${partner.provider} · ${partner.model}` : partner.connectionLabel; }
function successDescription(partner: Partner) {
  if (partner.isPrototype) return '模拟接入已建立，未访问任何外部服务。';
  if (partner.sourceMode === 'api_partner') return 'API 已通过系统安全凭据库配置，聊天将使用选定服务。';
  if (partner.sourceMode === 'local_cli') return `本机 ${partner.adapterType === 'codex_cli' ? 'Codex' : 'Claude Code'} 已就绪；原配置、Skills、MCP 与记忆仍由 CLI 管理。`;
  return '该伙伴已通过 CyberBoss 服务器安全桥接接回既有线程。';
}
function boundaryCopy(mode: FormMode) { return mode === 'existing_thread' ? '认证明文只交给 Electron 主进程，并使用系统安全凭据库加密保存；Cookie 仅保留在内存。' : mode === 'local_cli' ? '不会修改 CLI 配置，只管理星丛启动的子进程。' : 'API Key 只交给 Electron 主进程，并使用系统安全凭据库加密保存。'; }
