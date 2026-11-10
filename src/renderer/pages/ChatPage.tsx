import { useNativeCodexHistory } from '../app/nativeCodexHistory';
import { useSingleChatTimeline } from '../app/useSingleChatTimeline';
import { supportsContextHandoff } from '../app/singleChatRuntime';
import { ContextHandoffDialog, ContextHandoffDraftCard } from '../components/chat/ContextHandoffDialog';
import type { CyberBossChatFileCapabilities } from '../../shared/cyberBossChatAttachments';
import { MessageAttachmentCards } from '../components/chat/MessageAttachmentCards';
import { useCollapsibleRails } from '../components/layout/useCollapsibleRails';
import { SessionCommandNotice } from '../components/chat/SessionCommandNotice';
import { ConversationSearch } from '../components/chat/ConversationSearch';
import { JumpToLatest } from '../components/chat/JumpToLatest';
import { TurnNavigator } from '../components/chat/TurnNavigator';
import { WorkspaceShortcuts } from '../components/layout/WorkspaceShortcuts';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  FileImage,
  FileSearch,
  FileText,
  FolderKanban,
  FolderOpen,
  Globe2,
  Inbox,
  ListTodo,
  MessageSquarePlus,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Quote,
  Search,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { conversationWorkspaceMismatch, usePrototype, type WorkspaceSwitchDecision } from '../app/PrototypeProvider';
import type { MemorySourceNavigationState } from '../app/memorySourceNavigation';
import { isAsteriumUser } from '../../shared/identity';
import { ASTERIUM_LOGO_DATA_URL } from '../assets/asteriumLogoData';
import { Brand, MainHeader } from '../components/layout/AppNavigation';
import { Avatar } from '../components/ui/Avatar';
import { Composer } from '../components/ui/Composer';
import { CodexModelPicker } from '../components/ui/CodexModelPicker';
import { Modal } from '../components/ui/Modal';
import { FileDeletionModal } from '../components/ui/FileDeletionModal';
import { DiaryModal } from '../components/diary/DiaryModal';
import { fileDeletionErrorMessage } from '../app/fileDeletionPresentation';
import { PartnerQuickCard } from '../components/ui/PartnerQuickCard';
import { MarkdownContent } from '../components/chat/MarkdownContent';
import { MessageQuoteCard } from '../components/chat/MessageQuoteCard';
import { TurnTimeline } from '../components/chat/TurnTimeline';
import { FilePreviewPane, type PreviewTab } from '../components/chat/FilePreviewPane';
import type { Conversation, ConversationArtifact, Message, MessageQuote } from '../types/domain';
import type { DelegationBatchView } from '../../main/runtime/PartnerDelegation';
import type { ConversationAttachmentInfo, MessageAttachment, PendingMessageAttachment } from '../../shared/agentProtocol';
import { assistantMessageText, formatMessageWithQuote } from '../app/messageQuote';
import { partnerStatusLabel } from '../components/chat/partnerStatusLabel';
import { friendlyRuntimeErrorMessage } from '../app/runtimeErrorPresentation';
import type { FileDeletionInspection } from '../../shared/projectWorkspace';

type ChatOverlay = 'new-chat' | 'rename-chat' | 'archive-chat' | 'archive-partner' | 'save-artifact' | 'diary' | null;
const emptyDelegationBatches: DelegationBatchView[] = [];

export function ChatPage() {
  const rails = useCollapsibleRails('chat');
  const navigate = useNavigate();
  const location = useLocation();
  const {
    state,
    selectPartner,
    selectConversation,
    chatHistoryPage,
    chatHistoryLoading,
    chatHistoryLoadFailed,
    retryChatHistory,
    selectProject,
    createConversation,
    renameConversation,
    archiveConversation,
    archivePartnerConversations,
    ensureConversation,
    toggleConversationPin,
    setConversationPermissionMode,
    setConversationPlanMode,
    setConversationCodexModel,
    prepareConversationWorkspace,
    sendChatMessage,
    selectGroupChat,
    contextHandoffDraft,
    setContextHandoffDraft,
    chatCompactions,
    dismissChatCompaction,
    executeChatCommand,
    chatCommandResults,
    dismissChatCommandResult,
    chatMaintenanceRunning,
    sendChatGuidance,
    regenerateChatTurn,
    cancelChatRun,
    resolveChatAuthorization,
    resolveChatUserInput,
    updatePartner,
    updatePartnerWorkspaceGrants,
    addConversationArtifact,
    removeConversationArtifact,
    createProject,
    addProjectFile,
  } = usePrototype();
  const messageEndRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const followLatestMessageRef = useRef(true);
  const scrollAnchor = useRef<{ id: string; top: number } | undefined>(undefined);
  const previousScrollTop = useRef(0);
  const [historyJump, setHistoryJump] = useState<{ conversationId: string; messageId: string }>();
  const appliedJump = useRef<typeof historyJump>(undefined);
  const conversationSearchTrigger = useRef<HTMLButtonElement>(null);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const stopFollowingLatest = useCallback(() => { followLatestMessageRef.current = false; }, []);
  const deferredGuidanceSendingRef = useRef(new Set<string>());
  const pendingSendRef = useRef<{ key: string; messageId: string; attachments?: MessageAttachment[] } | undefined>(undefined);
  const [overlay, setOverlay] = useState<ChatOverlay>(null);
  const [query, setQuery] = useState('');
  const availablePartners = state.partners.filter((partner) => !partner.isRemoved);
  const userProfile = state.userProfile;
  const userAvatar = userProfile.avatarDataUrl ?? ASTERIUM_LOGO_DATA_URL;
  const [newChatPartnerId, setNewChatPartnerId] = useState(state.activePartnerId || availablePartners[0]?.id || '');
  const [newChatTitle, setNewChatTitle] = useState('');
  const [conversationTargetId, setConversationTargetId] = useState('');
  const [conversationTitle, setConversationTitle] = useState('');
  const [partnerArchiveTargetId, setPartnerArchiveTargetId] = useState('');
  const storedConversation = state.conversations.find((conversation) => conversation.id === state.activeConversationId);
  const historyPartner = state.partners.find((partner) => partner.id === storedConversation?.partnerId);
  const historyWindow = useSingleChatTimeline(storedConversation, chatHistoryPage);
  const nativeHistory = useNativeCodexHistory(historyWindow.conversation, historyPartner, location.pathname === '/chat' && !historyWindow.detached && !chatHistoryLoading);
  const activeConversation = nativeHistory.conversation;
  const activeConversationId = activeConversation?.id;
  const searchHistory = window.asteriumConversations?.searchHistory;
  const searchIndexed = useCallback((term: string, after?: string) => {
    if (!activeConversationId || !searchHistory) return Promise.resolve({ messageIds: [], hasMore: false });
    return searchHistory({ conversationId: activeConversationId, query: term, after });
  }, [activeConversationId, searchHistory]);
  const showAround = historyWindow.showAround;
  const revealHistoryMessage = useCallback(async (messageId: string) => {
    if (!activeConversationId) return false;
    const requestJump = () => {
      followLatestMessageRef.current = false;
      setHistoryJump({ conversationId: activeConversationId, messageId });
    };
    const row = document.getElementById('chat-message-' + messageId);
    if (row && messageListRef.current?.contains(row)) {
      requestJump();
      return true;
    }
    return showAround(messageId, requestJump);
  }, [activeConversationId, showAround]);
  const keepHistoryPosition = useCallback(() => {
    const list = messageListRef.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    const row = Array.from(list.querySelectorAll<HTMLElement>('.message-row'))
      .find(message => message.getBoundingClientRect().bottom >= top);
    followLatestMessageRef.current = false;
    scrollAnchor.current = row ? { id: row.id, top: row.getBoundingClientRect().top } : undefined;
  }, []);
  const [delegationSnapshot, setDelegationSnapshot] = useState<{ conversationId: string; batches: DelegationBatchView[] }>();
  const delegationBatches = delegationSnapshot && delegationSnapshot.conversationId === activeConversationId ? delegationSnapshot.batches : emptyDelegationBatches;
  const [delegationError, setDelegationError] = useState('');
  const chatRows = useMemo(() => buildChatRows(activeConversation, delegationBatches), [activeConversation, delegationBatches]);
  useEffect(() => {
    const bridge = window.asteriumDelegation;
    if (!activeConversationId || !bridge) return;
    let disposed = false;
    let reading = false;
    let previousSignature: string | undefined;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const batches = await bridge.list(activeConversationId);
        if (disposed) return;
        // IPC returns a new array even if the displayed records haven't changed.
        const signature = JSON.stringify(batches);
        if (signature !== previousSignature) {
          previousSignature = signature;
          setDelegationSnapshot((current) => !current && !batches.length ? current : { conversationId: activeConversationId, batches });
        }
      } catch {
        if (!disposed) setDelegationError('委派记录暂时无法读取。');
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [activeConversationId]);
  const activePartner = state.partners.find((partner) => partner.id === (activeConversation?.partnerId ?? state.activePartnerId)) ?? availablePartners[0];
  const [handoffOpen, setHandoffOpen] = useState(false);
  const activeHandoff = contextHandoffDraft?.target.kind === 'single' && contextHandoffDraft.target.id === activeConversation?.id ? contextHandoffDraft : undefined;
  const handoffTargets = activePartner && supportsContextHandoff(activePartner)
    ? state.groupChats.filter(room => !room.archivedAt && room.memberIds.includes(activePartner.id))
      .map(room => ({ kind: 'group' as const, id: room.id, partnerId: activePartner.id, label: `${room.name} · ${activePartner.publicIdentity.displayName}` }))
    : [];
  const partnerRemoved = Boolean(activePartner?.isRemoved);
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const newChatPartners = availablePartners.filter((partner) => partner.sourceMode !== 'existing_thread');
  const pinnedConversations = state.conversations.filter((conversation) => conversation.isPinned && !conversation.isArchived);
  const [leftRailWidth, setLeftRailWidth] = useState(() => readRailWidth('asterium.chat.leftRailWidth', 260, 210, 340));
  const [rightRailWidth, setRightRailWidth] = useState(() => readRailWidth('asterium.chat.rightRailWidth', 286, 230, 380));
  const [previewWidth, setPreviewWidth] = useState(() => readRailWidth('asterium.chat.previewWidth', 420, 320, 860));
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [activePreviewId, setActivePreviewId] = useState('');
  const [editingMessageId, setEditingMessageId] = useState('');
  const [editingText, setEditingText] = useState('');
  const [highlightedMessageId, setHighlightedMessageId] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState('');
  const [collapsedPartners, setCollapsedPartners] = useState<Record<string, boolean>>(() => readCollapsedPartners(state.activePartnerId));
  const [artifactMenu, setArtifactMenu] = useState<{ id: string; conversationId: string; x: number; y: number; fromList: boolean } | null>(null);
  const [artifactLocation, setArtifactLocation] = useState<{ id: string; conversationId: string }>();
  const [artifactActionError, setArtifactActionError] = useState<{ conversationId: string; message: string }>();
  const [artifactDeletionTarget, setArtifactDeletionTarget] = useState<{ conversationId: string; id: string; artifactRef: string }>();
  const [fileDeletionInspection, setFileDeletionInspection] = useState<FileDeletionInspection>();
  const [fileDeletionBusy, setFileDeletionBusy] = useState(false);
  const [fileDeletionError, setFileDeletionError] = useState('');
  const [attachmentMenu, setAttachmentMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [artifactProjectTarget, setArtifactProjectTarget] = useState<{ kind: 'artifact' | 'attachment'; id: string; conversationId: string } | null>(null);
  const [artifactProjectId, setArtifactProjectId] = useState(state.activeProjectId);
  const [newArtifactProjectName, setNewArtifactProjectName] = useState('');
  const [artifactProjectError, setArtifactProjectError] = useState('');
  const [artifactProjectBusy, setArtifactProjectBusy] = useState(false);
  const [artifactScrollbarVisible, setArtifactScrollbarVisible] = useState(false);
  const [attachmentScrollbarVisible, setAttachmentScrollbarVisible] = useState(false);
  const [composerFocusKey, setComposerFocusKey] = useState(0);
  const [workspaceDecisionBusy, setWorkspaceDecisionBusy] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleError, setLifecycleError] = useState('');
  const [pendingGuidanceByConversation, setPendingGuidanceByConversation] = useState<Record<string, { content: string; quote?: MessageQuote; targetRunId: string; clientMessageId: string; state: 'staged' | 'deferred' | 'sending'; error?: string }>>({});
  const [pendingQuote, setPendingQuote] = useState<MessageQuote>();
  const [quoteMenu, setQuoteMenu] = useState<{ quote: MessageQuote; x: number; y: number } | null>(null);
  const [workspaceSendRequest, setWorkspaceSendRequest] = useState<{
    content: string;
    pending: PendingMessageAttachment[];
    quote?: MessageQuote;
    resolve: (sent: boolean) => void;
  } | null>(null);
  const [collapsedResourceSections, setCollapsedResourceSections] = useState(() => readCollapsedResourceSections());
  const [userAttachments, setUserAttachments] = useState<ConversationAttachmentInfo[]>([]);
  const [expandedAttachmentSources, setExpandedAttachmentSources] = useState<Record<string, boolean>>({});
  const attachmentGroups = useMemo(() => groupUserAttachments(userAttachments), [userAttachments]);
  const deliveryRecords = activeConversation?.artifacts;
  const visibleDeliveries = useMemo(() => latestDeliveriesBySource(deliveryRecords ?? []), [deliveryRecords]);
  const artifactMenuFile = artifactMenu?.conversationId === activeConversationId
    ? deliveryRecords?.find((item) => item.id === artifactMenu?.id)
    : undefined;
  useLayoutEffect(() => {
    if (!artifactLocation || artifactLocation.conversationId !== activeConversationId || rails.right || collapsedResourceSections.artifacts) return;
    const row = document.getElementById(`chat-delivery-${artifactLocation.id}`);
    row?.scrollIntoView?.({ block: 'nearest' });
    row?.focus({ preventScroll: true });
    setArtifactLocation(undefined);
  }, [activeConversationId, artifactLocation, collapsedResourceSections.artifacts, rails.right]);
  const turnMessages = useMemo(() => activeConversation?.messages.filter((message) => isAsteriumUser(message.authorId)) ?? [], [activeConversation]);
  const participatingProjects = useMemo(() => state.projects.filter((project) => activePartner && project.memberIds.includes(activePartner.id)), [activePartner, state.projects]);
  const latestUserMessage = [...(activeConversation?.messages ?? [])].reverse().find((message) => isAsteriumUser(message.authorId));
  const latestAssistantMessage = [...(activeConversation?.messages ?? [])].reverse().find((message) => !isAsteriumUser(message.authorId) && message.authorId !== 'system');
  const pendingGuidance = activeConversationId ? pendingGuidanceByConversation[activeConversationId] : undefined;
  const workspaceMismatch = conversationWorkspaceMismatch(activePartner, activeConversation);
  const compaction = activeConversation ? chatCompactions[activeConversation.id] : undefined;
  const commandResult = activeConversation ? chatCommandResults[activeConversation.id] : undefined;
  const dismissCommandResult = useMemo(() => () => {
    if (activeConversationId && commandResult) dismissChatCommandResult(activeConversationId, commandResult);
  }, [activeConversationId, commandResult, dismissChatCommandResult]);
  const dismissCompaction = useMemo(() => () => {
    if (activeConversationId && compaction) dismissChatCompaction(activeConversationId, compaction);
  }, [activeConversationId, compaction, dismissChatCompaction]);
  const compacting = compaction?.state === 'running' || Boolean(activeConversation && chatMaintenanceRunning[activeConversation.id]);
  const nativeThreadUnavailable = activeConversation?.nativeThreadState === 'unavailable' || activeConversation?.nativeThreadState === 'deleted';
  const canRegenerate = !historyWindow.detached && !chatHistoryLoading && activePartner?.sourceMode !== 'existing_thread'
    && !compacting
    && !activeConversation?.activeRun && !activeConversation?.isDisabled && !workspaceMismatch && !latestUserMessage?.isGuidance;
  const cyberBossChat = activePartner?.sourceMode === 'existing_thread';
  const cyberBossConnected = cyberBossChat && !activePartner.isPrototype && activePartner.configured && activePartner.connectionStatus === 'connected';
  const cyberBossPartnerId = cyberBossConnected ? activePartner.id : undefined;
  const cyberBossServiceUrl = cyberBossConnected ? activePartner.serviceUrl : undefined;
  const cyberBossCredentialRef = cyberBossConnected ? activePartner.credentialRef : undefined;
  const cyberBossThreadId = cyberBossConnected ? activePartner.threadId : undefined;
  const cyberBossBinding = JSON.stringify([cyberBossPartnerId, cyberBossServiceUrl, cyberBossCredentialRef, cyberBossThreadId]);
  const [fileCapability, setFileCapability] = useState<{ binding: string; policy?: CyberBossChatFileCapabilities }>();
  const cyberBossFileCapabilities = fileCapability?.binding === cyberBossBinding ? fileCapability.policy : undefined;

  useEffect(() => {
    const query = window.asteriumAgents?.getExistingThreadFileCapabilities;
    if (!query || !cyberBossPartnerId || !cyberBossServiceUrl || !cyberBossCredentialRef || !cyberBossThreadId) return;
    let active = true;
    void query({ serviceUrl: cyberBossServiceUrl, credentialRef: cyberBossCredentialRef, threadId: cyberBossThreadId })
      .then(policy => { if (active) setFileCapability({ binding: cyberBossBinding, policy }); })
      .catch(() => { if (active) setFileCapability({ binding: cyberBossBinding }); });
    return () => { active = false; };
  }, [cyberBossBinding, cyberBossPartnerId, cyberBossServiceUrl, cyberBossCredentialRef, cyberBossThreadId]);
  const attachmentsEnabled = Boolean(activeConversation && activePartner && (
    cyberBossConnected
    || (activePartner.sourceMode === 'api_partner' && !activePartner.isPrototype && activePartner.configured)
    || (activePartner.sourceMode === 'local_cli' && (activePartner.connectionKind === 'local_claude' || activePartner.connectionKind === 'local_codex'))
  ));
  const localNativeControls = activePartner?.sourceMode === 'local_cli' && (activePartner.connectionKind === 'local_claude' || activePartner.connectionKind === 'local_codex');
  const apiRuntimeControls = Boolean(activePartner?.sourceMode === 'api_partner' && !activePartner.isPrototype && activePartner.configured);
  const runtimeControls = localNativeControls || apiRuntimeControls;
  const permissionDisabledReason = runtimeControls ? undefined : activePartner?.sourceMode === 'api_partner'
    ? '请先完成 API 伙伴配置'
    : '接回伙伴只展示对方实际提供的审批事件';
  const automaticPermissionAvailable = Boolean(apiRuntimeControls || (localNativeControls && activePartner?.sourceMode === 'local_cli' && activePartner.adapterType === 'codex_cli'));
  const planAvailable = Boolean(runtimeControls);
  const compactDisabledReason = !runtimeControls ? '当前伙伴不提供可控制的会话压缩'
    : activePartner?.sourceMode === 'api_partner' && !activePartner.apiSessionHistoryEnabled ? '请先开启此伙伴的会话记录'
      : !activeConversation?.sessionId ? '先完成一轮对话后再压缩'
        : activeConversation.isArchived ? '请先恢复这段归档对话'
          : activeConversation.awaitingFirstResponse || activeConversation.activeRun ? '请等待当前任务结束'
          : workspaceMismatch ? '请先处理当前对话的工作区变更'
            : pendingGuidance ? '请先处理暂存的中途消息' : undefined;
  const planDisabledReason = activePartner?.sourceMode === 'api_partner'
    ? '请先完成 API 伙伴配置'
    : '当前伙伴不提供可控制的原生 Plan';
  const canStageGuidance = Boolean(activeConversation?.activeRun
    && (apiRuntimeControls || localNativeControls));
  const memorySourceTarget = (location.state as MemorySourceNavigationState | null)?.memorySourceTarget;

  const commitAndSend = async (content: string, pending: PendingMessageAttachment[], quote?: MessageQuote, workspaceDecision?: WorkspaceSwitchDecision) => {
    if (!activeConversation || (pending.length > 0 && !attachmentsEnabled)) return false;
    try {
      followLatestMessageRef.current = true;
      const selections = pending.map(item => item.selectionId);
      const key = JSON.stringify([activeConversation.id, content, selections, quote]);
      let prepared = pendingSendRef.current;
      if (prepared?.key !== key) {
        const messageId = `message-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
        const attachments = selections.length ? await window.asteriumAttachments?.commit(activeConversation.id, selections, messageId) : undefined;
        if (selections.length && !attachments) return false;
        prepared = { key, messageId, attachments };
        pendingSendRef.current = prepared;
      }
      const sent = await sendChatMessage(activeConversation.id, content, prepared.attachments, prepared.messageId, workspaceDecision, quote, activeHandoff);
      if (!sent) return false;
      pendingSendRef.current = undefined;
      historyWindow.returnToLatest();
      setPendingQuote(undefined);
      void window.asteriumAttachments?.list(activeConversation.id).then(setUserAttachments);
      return true;
    } catch {
      return false;
    }
  };

  const sendWithAttachments = (content: string, pending: PendingMessageAttachment[], quote?: MessageQuote) => {
    if (activeConversation?.activeRun) {
      if (!canStageGuidance || pending.length || pendingGuidance || !content.trim()) return false;
      const conversationId = activeConversation.id;
      const clientMessageId = `client-guidance-${globalThis.crypto.randomUUID()}`;
      setPendingGuidanceByConversation((current) => ({ ...current, [conversationId]: { content: content.trim(), ...(quote ? { quote } : {}), targetRunId: activeConversation.activeRun!.runId, clientMessageId, state: 'staged' } }));
      void window.asteriumDelegation?.interruptWait(conversationId).then(interrupted => {
        if (!interrupted) return;
        setPendingGuidanceByConversation(current => current[conversationId]?.clientMessageId === clientMessageId
          ? { ...current, [conversationId]: { ...current[conversationId], state: 'deferred' } }
          : current);
        cancelChatRun(conversationId);
      }).catch(() => undefined);
      setPendingQuote(undefined);
      return true;
    }
    if (!workspaceMismatch) return commitAndSend(content, pending, quote);
    return new Promise<boolean>((resolve) => {
      setWorkspaceSendRequest({ content, pending: [...pending], ...(quote ? { quote } : {}), resolve });
    });
  };

  const sendPendingGuidance = async () => {
    if (!activeConversation || !pendingGuidance || pendingGuidance.state !== 'staged') return;
    const conversationId = activeConversation.id;
    setPendingGuidanceByConversation((current) => ({ ...current, [conversationId]: { ...current[conversationId], state: 'sending', error: undefined } }));
    if (!activeConversation.activeRun) {
      const sent = await sendChatMessage(conversationId, pendingGuidance.content, undefined, undefined, undefined, pendingGuidance.quote);
      setPendingGuidanceByConversation((current) => {
        if (sent) {
          const next = { ...current };
          delete next[conversationId];
          return next;
        }
        return { ...current, [conversationId]: { ...pendingGuidance, state: 'staged', error: '未能发送，请重试。' } };
      });
      return;
    }
    const disposition = await sendChatGuidance(conversationId, pendingGuidance.content, pendingGuidance.targetRunId, pendingGuidance.quote, pendingGuidance.clientMessageId);
    setPendingGuidanceByConversation((current) => {
      if (disposition === 'accepted') {
        const next = { ...current };
        delete next[conversationId];
        return next;
      }
      if (disposition === 'deferred') return { ...current, [conversationId]: { ...pendingGuidance, state: 'deferred' } };
      return { ...current, [conversationId]: { ...pendingGuidance, state: 'staged', error: '未能发送，请重试。' } };
    });
  };

  const discardPendingGuidance = () => {
    if (!activeConversationId) return;
    setPendingGuidanceByConversation((current) => {
      const next = { ...current };
      delete next[activeConversationId];
      return next;
    });
  };

  const closeWorkspaceDecision = () => {
    if (workspaceDecisionBusy) return;
    workspaceSendRequest?.resolve(false);
    setWorkspaceSendRequest(null);
    setComposerFocusKey((value) => value + 1);
  };

  const chooseWorkspaceDecision = async (decision: WorkspaceSwitchDecision) => {
    if (!workspaceSendRequest || !activeConversation || workspaceDecisionBusy) return;
    setWorkspaceDecisionBusy(true);
    const request = workspaceSendRequest;
    const prepared = await prepareConversationWorkspace(activeConversation.id, decision);
    const sent = prepared ? await commitAndSend(request.content, request.pending, request.quote, decision) : false;
    request.resolve(sent);
    setWorkspaceSendRequest(null);
    setWorkspaceDecisionBusy(false);
    setComposerFocusKey((value) => value + 1);
  };

  const openUserAttachment = async (attachmentId: string) => {
    if (!activeConversation || !window.asteriumAttachments) return;
    const tabId = `user-attachment:${attachmentId}`;
    if (previewTabs.some((tab) => tab.id === tabId)) return setActivePreviewId(tabId);
    try {
      const info = await window.asteriumAttachments.inspect(attachmentId, activeConversation.id);
      if (info.localReference && info.availability === 'available') {
        await window.asteriumAttachments.reveal(attachmentId, activeConversation.id);
        return;
      }
      const tab: PreviewTab = {
        id: tabId, name: info.name, artifactRef: info.id, mediaType: info.mediaType, sizeBytes: info.sizeBytes,
        createdAt: info.createdAt, availability: info.availability === 'available' ? 'available' : 'missing',
        open: () => { void window.asteriumAttachments?.open(info.id, activeConversation.id); },
      };
      setPreviewTabs((current) => [...current, tab]);
      setActivePreviewId(tabId);
      const content = await window.asteriumAttachments.read(info.id, activeConversation.id);
      setPreviewTabs((current) => current.map((item) => item.id === tabId ? { ...item, content } : item));
    } catch {
      setPreviewTabs((current) => current.map((item) => item.id === tabId ? { ...item, error: '附件文件不可用' } : item));
    }
  };

  const [indexedSidebar, setIndexedSidebar] = useState<{ query: string; ids: string[] }>();
  useEffect(() => {
    if (!normalizedQuery || !searchHistory) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void searchHistory({ query: normalizedQuery.slice(0, 512) }).then(result => {
        if (live) setIndexedSidebar({ query: normalizedQuery, ids: result.conversationIds });
      }).catch(() => { if (live) setIndexedSidebar({ query: normalizedQuery, ids: [] }); });
    }, 120);
    return () => { live = false; window.clearTimeout(timer); };
  }, [normalizedQuery, searchHistory]);
  const sidebarSearching = Boolean(searchHistory && normalizedQuery && indexedSidebar?.query !== normalizedQuery);
  const matchingConversationIds = useMemo(() => {
    const indexed = new Set(indexedSidebar?.query === normalizedQuery ? indexedSidebar.ids : []);
    return new Set(
    state.conversations
      .filter((conversation) => !conversation.isArchived && (!normalizedQuery
        || indexed.has(conversation.id)
        || conversation.title.toLocaleLowerCase('zh-CN').includes(normalizedQuery)
        || conversation.messages.some((message) => message.content.toLocaleLowerCase('zh-CN').includes(normalizedQuery)
          || message.quote?.text.toLocaleLowerCase('zh-CN').includes(normalizedQuery))))
      .map((conversation) => conversation.id),
    );
  }, [indexedSidebar, normalizedQuery, state.conversations]);

  useLayoutEffect(() => {
    const root = messageListRef.current;
    if (!root || !activeConversationId) return;
    const switchedConversation = previousConversationIdRef.current !== activeConversationId;
    previousConversationIdRef.current = activeConversationId;
    if (switchedConversation) {
      scrollAnchor.current = undefined;
      previousScrollTop.current = 0;
    }
    if (!switchedConversation && !followLatestMessageRef.current) return;
    root.scrollTop = root.scrollHeight;
    followLatestMessageRef.current = true;
  }, [activeConversation, activeConversationId]);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const anchor = scrollAnchor.current;
    if (anchor) {
      scrollAnchor.current = undefined;
      const row = document.getElementById(anchor.id);
      if (row && list.contains(row)) list.scrollTop += row.getBoundingClientRect().top - anchor.top;
    }
    if (!historyJump || historyJump.conversationId !== activeConversationId || appliedJump.current === historyJump) return;
    const row = document.getElementById('chat-message-' + historyJump.messageId);
    if (!row || !list.contains(row)) return;
    appliedJump.current = historyJump;
    row.scrollIntoView?.({ block: 'center' });
    setHighlightedMessageId(historyJump.messageId);
  }, [activeConversation, activeConversationId, historyJump]);

  useEffect(() => {
    if (!historyJump) return;
    const timer = window.setTimeout(() => setHighlightedMessageId(value => value === historyJump.messageId ? '' : value), 1800);
    return () => window.clearTimeout(timer);
  }, [historyJump]);

  useEffect(() => {
    if (memorySourceTarget?.kind !== 'single_chat') return;
    const conversation = state.conversations.find((item) => item.id === memorySourceTarget.conversationId && !item.isArchived);
    if (!conversation) return;
    if (activeConversationId !== conversation.id) {
      followLatestMessageRef.current = false;
      selectConversation(conversation.id);
      return;
    }
    if (chatHistoryLoading) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void revealHistoryMessage(memorySourceTarget.messageId).then(found => {
        if (!found || !live) return;
        const currentState = (location.state as MemorySourceNavigationState | null) ?? {};
        navigate(location.pathname, { replace: true, state: { ...currentState, memorySourceTarget: undefined } satisfies MemorySourceNavigationState });
      });
    }, 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [activeConversationId, chatHistoryLoading, location.pathname, location.state, memorySourceTarget, navigate, revealHistoryMessage, selectConversation, state.conversations]);

  useEffect(() => {
    const root = messageListRef.current;
    if (!root || typeof MutationObserver === 'undefined') return;
    let pendingScroll: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      if (!followLatestMessageRef.current) return;
      if (pendingScroll) clearTimeout(pendingScroll);
      pendingScroll = setTimeout(() => {
        if (followLatestMessageRef.current) root.scrollTop = root.scrollHeight;
      }, 0);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (pendingScroll) clearTimeout(pendingScroll);
    };
  }, [activeConversationId]);

  const trackMessageScroll = () => {
    const root = messageListRef.current;
    if (!root) return;
    const upward = root.scrollTop < previousScrollTop.current;
    previousScrollTop.current = root.scrollTop;
    if (conversationSearchOpen) return;
    followLatestMessageRef.current = !historyWindow.detached && root.scrollHeight - root.scrollTop - root.clientHeight <= 72;
    if (upward && root.scrollTop <= 56 && historyWindow.hasOlder && !historyWindow.loading) {
      void historyWindow.loadOlder(keepHistoryPosition);
    }
  };

  useEffect(() => {
    window.localStorage.setItem('asterium.chat.leftRailWidth', String(leftRailWidth));
  }, [leftRailWidth]);

  useEffect(() => {
    window.localStorage.setItem('asterium.chat.rightRailWidth', String(rightRailWidth));
  }, [rightRailWidth]);

  useEffect(() => {
    window.localStorage.setItem('asterium.chat.previewWidth', String(previewWidth));
  }, [previewWidth]);

  useEffect(() => {
    window.localStorage.setItem('asterium.chat.collapsedPartners', JSON.stringify(collapsedPartners));
  }, [collapsedPartners]);

  useEffect(() => {
    if (!activePartner) return;
    setCollapsedPartners((current) => ({ ...current, [activePartner.id]: false }));
  }, [activePartner]);

  useEffect(() => {
    const ready = Object.entries(pendingGuidanceByConversation).find(([conversationId, guidance]) => {
      if (guidance.state !== 'deferred' || deferredGuidanceSendingRef.current.has(conversationId)) return false;
      return !state.conversations.find((conversation) => conversation.id === conversationId)?.activeRun;
    });
    if (!ready) return;
    const [conversationId, guidance] = ready;
    deferredGuidanceSendingRef.current.add(conversationId);
    setPendingGuidanceByConversation((current) => ({ ...current, [conversationId]: { ...guidance, state: 'sending', error: undefined } }));
    void sendChatMessage(conversationId, guidance.content, undefined, undefined, undefined, guidance.quote).then((sent) => {
      setPendingGuidanceByConversation((current) => {
        if (sent) {
          const next = { ...current };
          delete next[conversationId];
          return next;
        }
        return { ...current, [conversationId]: { ...guidance, state: 'staged', error: '自动发送失败，请重试。' } };
      });
    }).finally(() => deferredGuidanceSendingRef.current.delete(conversationId));
  }, [pendingGuidanceByConversation, sendChatMessage, state.conversations]);

  useEffect(() => {
    setPreviewTabs([]);
    setActivePreviewId('');
    setArtifactMenu(null);
    setAttachmentMenu(null);
    setQuoteMenu(null);
    setPendingQuote(undefined);
    setExpandedAttachmentSources({});
  }, [activeConversationId]);

  useEffect(() => {
    let active = true;
    if (!activeConversationId || !window.asteriumAttachments) { setUserAttachments([]); return; }
    void window.asteriumAttachments.list(activeConversationId).then((items) => { if (active) setUserAttachments(items); }).catch(() => { if (active) setUserAttachments([]); });
    return () => { active = false; };
  }, [activeConversationId]);

  useEffect(() => {
    if (!activeConversation || !window.asteriumArtifacts) return;
    const refresh = () => {
      for (const artifact of activeConversation.artifacts ?? []) {
        void window.asteriumArtifacts?.inspect(artifact.artifactRef).then((info) => info ? addConversationArtifact(activeConversation.id, {
          ...artifact, name: info.name, mediaType: info.mediaType, sizeBytes: info.sizeBytes,
          sourceKind: info.sourceKind, registrationMethod: info.registrationMethod, availability: info.availability, cached: info.cached, localSourceKey: info.localSourceKey,
        }) : removeConversationArtifact(activeConversation.id, artifact.artifactRef)).catch(() => undefined);
      }
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
    // Refresh only when switching conversations; artifact updates inside this effect must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id]);

  useEffect(() => {
    if (!artifactMenu && !attachmentMenu && !quoteMenu) return;
    const close = () => { setArtifactMenu(null); setAttachmentMenu(null); setQuoteMenu(null); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [artifactMenu, attachmentMenu, quoteMenu]);

  const openNewChat = (partnerId?: string) => {
    const requested = newChatPartners.find((partner) => partner.id === partnerId)?.id;
    const active = newChatPartners.find((partner) => partner.id === activePartner?.id)?.id;
    setNewChatPartnerId(requested || active || newChatPartners[0]?.id || '');
    setNewChatTitle('');
    setOverlay('new-chat');
  };

  const toggleResourceSection = (section: 'artifacts' | 'attachments', collapsed?: boolean) => {
    setCollapsedResourceSections((current) => {
      const next = { ...current, [section]: collapsed ?? !current[section] };
      window.localStorage.setItem('asterium.chat.collapsedResourceSections', JSON.stringify(next));
      return next;
    });
  };

  const submitNewChat = () => {
    if (!newChatPartnerId) return;
    createConversation(newChatPartnerId, newChatTitle);
    setOverlay(null);
  };

  const openRename = (conversationId: string) => {
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    setConversationTargetId(conversation.id);
    setConversationTitle(conversation.title);
    setOverlay('rename-chat');
  };

  const openArchive = (conversationId: string) => {
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation || conversation.activeRun) return;
    setConversationTargetId(conversation.id);
    setConversationTitle(conversation.title);
    setLifecycleError('');
    setOverlay('archive-chat');
  };

  const confirmArchive = async () => {
    setLifecycleBusy(true);
    setLifecycleError('');
    const result = await archiveConversation(conversationTargetId);
    setLifecycleBusy(false);
    if (!result.ok) return setLifecycleError(result.message ?? '归档失败。');
    setOverlay(null);
  };

  const startRailResize = (side: 'left' | 'right' | 'preview', event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const initialWidth = side === 'left' ? leftRailWidth : side === 'right' ? rightRailWidth : previewWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const delta = pointerEvent.clientX - startX;
      if (side === 'left') setLeftRailWidth(clamp(initialWidth + delta, 210, 340));
      else if (side === 'right') setRightRailWidth(clamp(initialWidth - delta, 230, 380));
      else setPreviewWidth(clamp(initialWidth - delta, 320, 860));
    };
    const handlePointerUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  };

  const chatLayoutStyle = {
    '--chat-left-width': rails.left ? '0px' : `${leftRailWidth}px`,
    '--chat-left-gap': rails.left ? '0px' : '12px',
    '--chat-right-width': rails.right ? '0px' : `${rightRailWidth}px`,
    '--chat-right-gap': rails.right ? '0px' : '12px',
    '--chat-preview-gap': previewTabs.length ? '12px' : '0px',
    '--chat-preview-width': previewTabs.length ? `${previewWidth}px` : '0px',
  } as CSSProperties;

  const togglePartnerGroup = (partnerId: string, collapsed: boolean) => {
    setCollapsedPartners((current) => ({ ...current, [partnerId]: !collapsed }));
    if (partnerId !== activePartner?.id) selectPartner(partnerId);
  };

  const createPartnerConversation = (partnerId: string) => {
    setCollapsedPartners((current) => ({ ...current, [partnerId]: false }));
    createConversation(partnerId);
  };

  const openArtifact = async (artifactId: string) => {
    const artifact = activeConversation?.artifacts?.find((item) => item.id === artifactId);
    if (!artifact) return;
    const existing = previewTabs.find((tab) => tab.id === artifactId);
    if (existing) return setActivePreviewId(artifactId);
    const tab: PreviewTab = { ...artifact };
    setPreviewTabs((current) => [...current, tab]);
    setActivePreviewId(artifactId);
    try {
      if (!window.asteriumArtifacts) throw new Error('请在桌面应用中预览此文件');
      const content = await window.asteriumArtifacts.read(artifact.artifactRef);
      setPreviewTabs((current) => current.map((item) => item.id === artifactId ? { ...item, content } : item));
    } catch (error) {
      setPreviewTabs((current) => current.map((item) => item.id === artifactId ? { ...item, error: artifactPreviewError(error, artifact.name) } : item));
    }
  };

  const openArtifactMenu = (id: string, event: ReactMouseEvent<HTMLElement>, fromList = false) => {
    if (!activeConversationId || !deliveryRecords?.some((item) => item.id === id)) return;
    event.preventDefault();
    setAttachmentMenu(null);
    setQuoteMenu(null);
    setArtifactMenu({ id, conversationId: activeConversationId, x: event.clientX, y: event.clientY, fromList });
  };

  const locateDelivery = (file: ConversationArtifact) => {
    const target = visibleDeliveries.find((item) => deliverySourceKey(item) === deliverySourceKey(file));
    if (!target || !activeConversationId) return;
    setArtifactMenu(null);
    if (rails.right) rails.toggle('right');
    toggleResourceSection('artifacts', false);
    setArtifactLocation({ id: target.id, conversationId: activeConversationId });
  };

  const runArtifactAction = async (file: ConversationArtifact, action: 'copyPath' | 'exportAs' | 'reveal' | 'openInBrowser', failure: string) => {
    if (!activeConversationId) return;
    setArtifactMenu(null);
    setArtifactActionError(undefined);
    try {
      const invoke = window.asteriumArtifacts?.[action];
      if (!invoke) throw new Error('ARTIFACT_ACTION_UNAVAILABLE');
      await invoke(file.artifactRef);
    } catch {
      setArtifactActionError({ conversationId: activeConversationId, message: failure });
    }
  };

  const finishArtifactDeletion = (target: { conversationId: string; id: string; artifactRef: string }) => {
    removeConversationArtifact(target.conversationId, target.artifactRef);
    setPreviewTabs((current) => current.filter((tab) => tab.id !== target.id && tab.artifactRef !== target.artifactRef));
    if (activePreviewId === target.id || activePreviewId === target.artifactRef) setActivePreviewId('');
    setArtifactDeletionTarget(undefined);
    setFileDeletionInspection(undefined);
    setFileDeletionError('');
  };

  const beginArtifactDeletion = async (fileId: string) => {
    const conversation = activeConversation;
    const file = conversation?.artifacts?.find((item) => item.id === fileId);
    if (!conversation || !file || !window.asteriumArtifacts?.inspectDeletion || !window.asteriumArtifacts.delete) return;
    const target = { conversationId: conversation.id, id: file.id, artifactRef: file.artifactRef };
    setArtifactMenu(null);
    setArtifactDeletionTarget(target);
    setFileDeletionBusy(true);
    setFileDeletionError('');
    try {
      const inspection = await window.asteriumArtifacts.inspectDeletion(file.artifactRef);
      setFileDeletionInspection(inspection);
      if (!inspection.requiresConfirmation && inspection.canDelete) {
        await window.asteriumArtifacts.delete(file.artifactRef);
        finishArtifactDeletion(target);
      }
    } catch (error) {
      setFileDeletionError(friendlyRuntimeErrorMessage(fileDeletionErrorMessage(error)));
    } finally {
      setFileDeletionBusy(false);
    }
  };

  const confirmArtifactDeletion = async () => {
    if (!artifactDeletionTarget || !window.asteriumArtifacts?.inspectDeletion || !window.asteriumArtifacts.delete) return;
    const target = artifactDeletionTarget;
    setFileDeletionBusy(true);
    setFileDeletionError('');
    try {
      await window.asteriumArtifacts.delete(target.artifactRef);
      finishArtifactDeletion(target);
    } catch (error) {
      try { setFileDeletionInspection(await window.asteriumArtifacts.inspectDeletion(target.artifactRef)); } catch { /* retain the last safe inspection */ }
      setFileDeletionError(friendlyRuntimeErrorMessage(fileDeletionErrorMessage(error)));
    } finally {
      setFileDeletionBusy(false);
    }
  };

  const openSaveToProject = (artifactId: string) => {
    if (!activeConversation) return;
    setArtifactProjectTarget({ kind: 'artifact', id: artifactId, conversationId: activeConversation.id });
    setArtifactProjectId(state.activeProjectId || state.projects[0]?.id || '');
    setNewArtifactProjectName('');
    setArtifactProjectError('');
    setOverlay('save-artifact');
  };

  const openAttachmentSaveToProject = (attachmentId: string) => {
    if (!activeConversation) return;
    setArtifactProjectTarget({ kind: 'attachment', id: attachmentId, conversationId: activeConversation.id });
    setArtifactProjectId(state.activeProjectId || state.projects[0]?.id || '');
    setNewArtifactProjectName('');
    setArtifactProjectError('');
    setOverlay('save-artifact');
  };

  const saveArtifactToProject = async () => {
    if (!artifactProjectTarget) return;
    setArtifactProjectError('');
    setArtifactProjectBusy(true);
    try {
      let projectId = artifactProjectId;
      if (!projectId && newArtifactProjectName.trim()) projectId = await createProject(newArtifactProjectName.trim());
      if (!projectId) return;
      const artifact = activeConversation?.artifacts?.find((item) => item.id === artifactProjectTarget.id);
      const attachment = userAttachments.find((item) => item.id === artifactProjectTarget.id);
      const saved = artifactProjectTarget.kind === 'artifact'
        ? artifact && window.asteriumArtifacts ? await window.asteriumArtifacts.saveToProject(artifact.artifactRef, projectId) : undefined
        : attachment && window.asteriumAttachments ? await window.asteriumAttachments.saveToProject(attachment.id, artifactProjectTarget.conversationId, projectId) : undefined;
      const source = artifactProjectTarget.kind === 'artifact' ? artifact : attachment;
      if (!saved || !source) throw new Error('PROJECT_SAVE_UNAVAILABLE');
      addProjectFile(projectId, {
        id: saved.fileId,
        fileId: saved.fileId,
        name: source.name,
        meta: `${saved.sourcePartnerName ? `${saved.sourcePartnerName} 交付` : artifactProjectTarget.kind === 'artifact' ? '来自文件交付' : '来自我的附件'} · ${formatBytes(source.sizeBytes)}`,
        kind: source.mediaType?.startsWith('image/') ? 'image' : source.mediaType?.includes('spreadsheet') ? 'sheet' : 'document',
        artifactId: saved.artifactId,
        contentHash: saved.contentHash,
        sizeBytes: saved.sizeBytes,
        savedAt: saved.savedAt,
        relativePath: saved.relativePath,
        revision: saved.revision,
        category: 'delivery',
        availability: 'available',
        ...(saved.sourcePartnerId ? { sourcePartnerId: saved.sourcePartnerId } : {}),
        ...(saved.sourcePartnerName ? { sourcePartnerName: saved.sourcePartnerName } : {}),
      });
      setArtifactProjectTarget(null);
      setOverlay(null);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('PROJECT_CREATE_CANCELLED'))) setArtifactProjectError(projectTransferError(error));
    } finally {
      setArtifactProjectBusy(false);
    }
  };

  const closePreview = (artifactId: string) => {
    setPreviewTabs((current) => {
      const index = current.findIndex((tab) => tab.id === artifactId);
      const next = current.filter((tab) => tab.id !== artifactId);
      if (artifactId === activePreviewId) setActivePreviewId(next[Math.min(index, next.length - 1)]?.id ?? '');
      return next;
    });
  };

  const makeQuote = (message: Message, kind: MessageQuote['kind'], text: string): MessageQuote | undefined => {
    const partner = state.partners.find((item) => item.id === message.authorId);
    const snapshot = text.trim();
    if (!partner || !snapshot) return undefined;
    return {
      sourceMessageId: message.id,
      sourcePartnerId: partner.id,
      sourcePartnerName: partner.publicIdentity.displayName,
      kind,
      text: snapshot,
    };
  };

  const quoteWholeMessage = (message: Message) => {
    const quote = makeQuote(message, 'full', assistantMessageText(message));
    if (!quote) return;
    setPendingQuote(quote);
    setComposerFocusKey((value) => value + 1);
  };

  const openQuoteSelectionMenu = (message: Message, text: string, x: number, y: number) => {
    const quote = makeQuote(message, 'selection', text);
    if (!quote) return;
    setArtifactMenu(null);
    setAttachmentMenu(null);
    setQuoteMenu({ quote, x, y });
  };

  const copyMessage = async (message: Message) => {
    await navigator.clipboard.writeText(formatMessageWithQuote(message.content, message.quote));
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? '' : current), 1300);
  };

  return (
    <main className="app-grid" data-page="chat" style={chatLayoutStyle}>
      <aside hidden={rails.left} className="glass-panel left-rail chat-left">
        <Brand />
        <nav className="chat-utility-nav" aria-label="单聊工具">
          <button type="button" onClick={() => openNewChat()}><MessageSquarePlus size={18} />创建对话</button>
          <WorkspaceShortcuts />
        </nav>
        <label className="chat-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索聊天记录" aria-label="搜索聊天记录" />
        </label>
        <section className="pinned-conversations" aria-label="置顶对话">
          <header><Pin size={14} /><span>置顶</span></header>
          {pinnedConversations.length ? pinnedConversations.map((conversation) => {
            const partner = state.partners.find((item) => item.id === conversation.partnerId);
            return (
              <div className="pinned-row" key={conversation.id}>
                <button type="button" onClick={() => selectConversation(conversation.id)} aria-label={`${conversation.title}${conversation.unreadCompletedAt ? '，有新回复' : ''}`}>
                  <span className="conversation-title"><span>{conversation.title}</span>{conversation.unreadCompletedAt && <Sparkles className="conversation-unread" aria-hidden="true" />}</span><small>{partner?.publicIdentity.displayName}</small>
                </button>
                <button className="icon-button" type="button" onClick={() => toggleConversationPin(conversation.id)} aria-label={`取消置顶 ${conversation.title}`} title="取消置顶"><PinOff size={14} /></button>
              </div>
            );
          }) : <p>把常用对话固定在这里</p>}
        </section>
        <div className="partner-groups scroll-region">
          {state.partners.map((partner) => {
            const conversations = state.conversations.filter((conversation) => !conversation.isArchived && conversation.partnerId === partner.id && matchingConversationIds.has(conversation.id));
            if (partner.isRemoved && conversations.length === 0) return null;
            if (normalizedQuery && conversations.length === 0) return null;
            const selected = partner.id === activePartner?.id;
            const collapsed = !normalizedQuery && (collapsedPartners[partner.id] ?? partner.id !== activePartner?.id);
            return (
              <section className={`partner-group ${collapsed ? 'is-collapsed' : ''}`} key={partner.id}>
                <div className={`partner-heading ${selected ? 'active' : ''}`}>
                  <button type="button" className="partner-select" onClick={() => togglePartnerGroup(partner.id, collapsed)} aria-expanded={!collapsed} aria-label={`${collapsed ? '展开' : '收起'} ${partner.publicIdentity.displayName} 的对话`}>
                    <Avatar partnerId={partner.id} name={partner.publicIdentity.displayName} src={partner.publicIdentity.avatarDataUrl} accent={partner.accent} size="sm" source={partner.sourceMode} selected={selected} />
                    <span><strong>{partner.publicIdentity.displayName}</strong><small>{partner.isRemoved ? '伙伴已移除' : partner.isPrototype ? '未连接' : partner.sourceMode === 'api_partner' ? 'API 伙伴' : '本地伙伴'}</small></span>
                  </button>
                  {!partner.isRemoved && partner.sourceMode !== 'existing_thread' && <button className="icon-button" type="button" onClick={() => createPartnerConversation(partner.id)} title={`直接新建和 ${partner.publicIdentity.displayName} 的对话`} aria-label={`直接新建和 ${partner.publicIdentity.displayName} 的对话`}><Plus size={18} /></button>}
                  {partner.isRemoved && conversations.length > 0 && <button className="icon-button" type="button" onClick={() => { setPartnerArchiveTargetId(partner.id); setOverlay('archive-partner'); }} title={`归档 ${partner.publicIdentity.displayName} 及其全部对话`} aria-label={`归档 ${partner.publicIdentity.displayName} 及其全部对话`}><Archive size={17} /></button>}
                </div>
                <div className="conversation-list">
                  {conversations.length ? conversations.map((conversation) => (
                    <div className={`conversation-row ${conversation.id === activeConversation?.id ? 'active' : ''}`} key={conversation.id}>
                      <button type="button" onClick={() => selectConversation(conversation.id)} aria-label={`${conversation.title}${conversation.unreadCompletedAt ? '，有新回复' : ''}`}>
                        <span className="conversation-icon">•••</span><span className="conversation-title"><span>{conversation.title}</span>{conversation.unreadCompletedAt && <Sparkles className="conversation-unread" aria-hidden="true" />}</span>
                      </button>
                      <button className="conversation-pin" type="button" onClick={() => toggleConversationPin(conversation.id)} aria-label={`${conversation.isPinned ? '取消置顶' : '置顶'} ${conversation.title}`} title={conversation.isPinned ? '取消置顶' : '置顶'}>
                        {conversation.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                      </button>
                      <button className="conversation-action" type="button" onClick={() => openRename(conversation.id)} aria-label={`修改对话标题 ${conversation.title}`} title="修改标题"><Pencil size={13} /></button>
                      {!conversation.isPrimaryThread && <button className="conversation-action" type="button" disabled={Boolean(conversation.activeRun)} onClick={() => openArchive(conversation.id)} aria-label={`归档对话 ${conversation.title}`} title={conversation.activeRun ? '任务运行中，暂不能归档' : '归档对话'}><Archive size={13} /></button>}
                    </div>
                  )) : !partner.isRemoved && partner.sourceMode !== 'existing_thread' && (
                    <button className="empty-conversation" type="button" onClick={() => createPartnerConversation(partner.id)}>＋ 开始新对话</button>
                  )}
                </div>
              </section>
            );
          })}
          {normalizedQuery && matchingConversationIds.size === 0 && <div className="search-empty">{sidebarSearching ? '查找历史中…' : '没有找到相关聊天记录'}</div>}
        </div>
        <button className="profile-row profile-row--button" type="button" onClick={() => navigate('/profile', { state: { from: '/chat' } })} title="编辑个人资料">
          <Avatar name={userProfile.displayName} src={userAvatar} accent="#91a9cf" size="sm" />
          <span><strong>{userProfile.displayName}</strong><small>{userProfile.introduction.trim() ? userProfile.introduction.trim().slice(0, 28) : '编辑个人资料'}</small></span>
          <MoreHorizontal size={18} />
        </button>
      </aside>

      <div hidden={rails.left} className="rail-resizer rail-resizer--left" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => startRailResize('left', event)} />

      <section className="glass-panel center-stage">
        <MainHeader rails={rails} conversationSearch={activeConversation ? {
          open: conversationSearchOpen,
          onToggle: () => setConversationSearchOpen(open => !open),
          triggerRef: conversationSearchTrigger,
        } : undefined} />
        <div className="partner-orbit" aria-label="伙伴快速切换">
          {availablePartners.map((partner) => (
            <button className={partner.id === activePartner?.id ? 'active' : ''} type="button" key={partner.id} onClick={() => selectPartner(partner.id)} title={partner.publicIdentity.displayName} aria-pressed={partner.id === activePartner?.id}>
              <Avatar partnerId={partner.id} name={partner.publicIdentity.displayName} src={partner.publicIdentity.avatarDataUrl} accent={partner.accent} size="md" source={partner.sourceMode} selected={partner.id === activePartner?.id} />
            </button>
          ))}
        </div>
        <section className="message-canvas">
          {partnerRemoved && <div className="removed-partner-notice">伙伴已移除 · 历史聊天仅供查看</div>}
          {activeConversation?.isDisabled && <div className="removed-partner-notice">伙伴配置来源已改变 · 这条旧会话已停用，请切换到自动创建的新对话</div>}
          {workspaceMismatch && <div className="removed-partner-notice">这条对话仍绑定原工作区「{activeConversation?.partnerRoot}」。你可以切回原工作区继续原 session；也可以直接发送，确认后将切换到当前工作区的独立 session。</div>}
          {activeConversation ? (<>
            {conversationSearchOpen && <ConversationSearch key={activeConversation.id} listRef={messageListRef} onNavigate={stopFollowingLatest}
              searchIndexed={searchHistory ? searchIndexed : undefined} onReveal={revealHistoryMessage} onClose={() => {
              setConversationSearchOpen(false);
              conversationSearchTrigger.current?.focus();
            }} />}
            <div className="message-scroll-region">
            {turnMessages.length > 1 && <TurnNavigator key={`turn-navigator:${activeConversation.id}`} turns={turnMessages} messageListRef={messageListRef}
              turnOffset={activeConversation.messages.length === historyWindow.conversation?.messages.length ? historyWindow.turnOffset : undefined}
              streaming={Boolean(activeConversation.activeRun)} onJump={stopFollowingLatest} />}
            <div className="message-list" ref={messageListRef} onScroll={trackMessageScroll}>
              {chatHistoryLoading && <div className="chat-history-controls" role="status">{chatHistoryLoadFailed
                ? <button type="button" className="secondary-button" onClick={retryChatHistory}>重新读取单聊历史</button> : '正在读取单聊历史…'}</div>}
              {historyWindow.hasOlder && <div className="chat-history-controls"><button type="button" className="secondary-button" disabled={historyWindow.loading}
                onClick={() => void historyWindow.loadOlder(keepHistoryPosition)}>加载更早消息</button></div>}
              {historyWindow.failed && <div className="chat-history-controls" role="status">历史暂时读不到，可以重试。</div>}
              {nativeHistory.unavailable && <div className="removed-partner-notice" role="status">暂时读不到 Codex 原线程，当前显示星丛已有记录。</div>}
              {nativeHistory.hasOlder && <button type="button" className="secondary-button" disabled={nativeHistory.loadingOlder} onClick={() => {
                keepHistoryPosition();
                void nativeHistory.loadOlder();
              }}>{nativeHistory.loadingOlder ? '正在读取原线程…' : '加载更早的 Codex 消息'}</button>}
              {chatRows.map(({ message, key, batches, receiptOnly }) => {
                const mine = isAsteriumUser(message.authorId);
                const author = mine ? undefined : state.partners.find((partner) => partner.id === message.authorId);
                const isLatestUser = message.id === latestUserMessage?.id;
                const isLatestAssistant = message.id === latestAssistantMessage?.id;
                const showStreamTail = !receiptOnly && !mine && message.runState === 'running'
                  && activeConversation.activeRun !== undefined
                  && activeConversation.activeRun.runId === message.runId
                  && !activeConversation.awaitingFirstResponse
                  && !activeConversation.pendingAuthorization
                  && !activeConversation.pendingUserInput;
                const quoteText = mine ? '' : assistantMessageText(message);
                const canQuote = !mine && Boolean(quoteText) && !message.isStreaming
                  && (message.runState === undefined || message.runState === 'completed')
                  && activeConversation.activeRun?.runId !== message.runId;
                const delegationReceipts = batches.map(batch => {
                  const pending = batch.tasks.some(task => task.status === 'queued' || task.status === 'running');
                  const uncertain = batch.tasks.some(task => task.status === 'uncertain');
                  const hasResult = batch.tasks.some(task => task.status === 'succeeded');
                  const senderName = author?.publicIdentity.displayName ?? '伙伴';
                  return {
                    id: batch.id,
                    requestId: batch.requestId,
                    card: (
                      <section className="delegation-receipt" aria-label="指派任务">
                        <header className="delegation-receipt__header">
                          <Inbox size={15} aria-hidden="true" />
                          <span role="status">{uncertain ? '正在确认复核结果' : pending ? '正在等小弟汇报回来' : hasResult ? `${senderName}派出的小弟带回了结果` : '指派任务'}</span>
                        </header>
                        {batch.summaryState === 'interrupted' && <small>汇总未完成，原始回复可在下方查看。</small>}
                        {batch.tasks.map(task => {
                          const cancel = task.status === 'queued' || (task.status === 'running' && !task.externalReview);
                          const retry = !task.rejected && ['failed', 'interrupted', 'timed_out'].includes(task.status);
                          const reason = task.reason && (delegationReviewReason[task.reason] ?? task.reason);
                          return (
                          <details className="delegation-receipt__task" key={task.id}>
                            <summary>
                              <span>{state.partners.find(partner => partner.id === task.targetPartnerId)?.publicIdentity.displayName ?? task.targetPartnerId}</span>
                              <small data-status={task.status}>{task.reason === 'DELEGATION_REVIEW_BUSY' ? '伙伴正忙' : ({ queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', timed_out: '超时', uncertain: '待确认' })[task.status]}</small>
                              <ChevronRight size={14} aria-hidden="true" />
                            </summary>
                            <div className="delegation-receipt__body">
                              <p>{task.instruction}</p>
                              {task.materials?.length ? <small>{task.materials.map(material => material.name).join('、')}</small> : null}
                              {task.result && <MarkdownContent>{task.result}</MarkdownContent>}
                              {reason && <small>{reason}</small>}
                              {(cancel || retry) && <button type="button" className="secondary-button" onClick={() => {
                                const action = cancel ? 'cancel' : 'retry';
                                setDelegationError('');
                                void window.asteriumDelegation?.control(activeConversation.id, task.id, action).catch(() => setDelegationError('操作未完成，请刷新任务状态后重试。'));
                              }}>{cancel ? '取消任务' : '重试任务'}</button>}
                            </div>
                          </details>
                          );
                        })}
                        {batch.summary && <details className="delegation-receipt__task">
                          <summary><span>查看任务汇总</span><span /><ChevronRight size={14} aria-hidden="true" /></summary>
                          <div className="delegation-receipt__body"><MarkdownContent>{batch.summary}</MarkdownContent></div>
                        </details>}
                        {delegationError && <small role="status">{delegationError}</small>}
                      </section>
                    ),
                  };
                });
                return (
                  <article id={`chat-message-${message.id}`} data-turn-id={mine ? message.id : undefined} className={`message-row ${mine ? 'message-row--mine' : ''} ${highlightedMessageId === message.id ? 'is-reference-target' : ''}`} key={`${activeConversation.id}:${key}`}>
                    {!mine && <Avatar partnerId={author?.id} name={author?.publicIdentity.displayName ?? '伙伴'} src={author?.publicIdentity.avatarDataUrl} accent={author?.accent} size="md" source={author?.sourceMode} />}
                    <div className="message-stack">
                      <div className="message-meta">{message.automation && <button className="text-button automation-message-label" type="button" onClick={() => navigate('/settings/partners?section=automations')}>自动化 · {message.automation.name}</button>}<strong>{mine ? userProfile.displayName : author?.publicIdentity.displayName}</strong><time>{message.createdAt}</time></div>
                      <div className={`message-bubble-row ${mine ? 'message-bubble-row--mine' : ''}`}>
                        {mine && <small className="delivery-state">{message.error?.code === 'CYBERBOSS_CHAT_MESSAGE_UNCERTAIN' ? '发送结果待确认' : deliveryLabel(message.status)}</small>}
                        <div className="message-bubble">
                          {editingMessageId === message.id ? <div className="message-editor">
                            {message.quote && <MessageQuoteCard quote={message.quote} className="message-quote-card--sent" />}
                            <textarea value={editingText} onChange={(event) => setEditingText(event.target.value)} autoFocus />
                            <div><button type="button" onClick={() => { setEditingMessageId(''); setEditingText(''); }}><X size={14} />取消</button><button type="button" disabled={!editingText.trim() && !message.attachments?.length} onClick={() => { regenerateChatTurn(activeConversation.id, editingText); setEditingMessageId(''); setEditingText(''); }}><Check size={14} />重新生成</button></div>
                          </div> : mine ? <>
                            {message.quote && <MessageQuoteCard quote={message.quote} className="message-quote-card--sent" />}
                            {message.content && <MarkdownContent className="message-content--user">{message.content}</MarkdownContent>}
                            <MessageAttachmentCards attachments={message.attachments} conversationId={activeConversation.id} onPreview={(attachment) => void openUserAttachment(attachment.id)} onContextMenu={(attachment, x, y) => { setArtifactMenu(null); setQuoteMenu(null); setAttachmentMenu({ id: attachment.id, x, y }); }} />
                          </> : <TurnTimeline message={message} delegationReceipts={delegationReceipts} partnerName={author?.publicIdentity.displayName ?? '伙伴'} pendingAuthorization={activeConversation.pendingAuthorization} pendingUserInput={activeConversation.pendingUserInput} onResolveAuthorization={(decision, persist) => resolveChatAuthorization(activeConversation.id, decision, persist)} onResolveUserInput={(answers, custom, requestId) => resolveChatUserInput(activeConversation.id, answers, custom, requestId)} onOpenArtifact={openArtifact} onArtifactContextMenu={openArtifactMenu} onQuoteSelection={canQuote ? (text, x, y) => openQuoteSelectionMenu(message, text, x, y) : undefined} />}
                        </div>
                      </div>
                      {showStreamTail && <span className="stream-tail" role="status" aria-label={`${author?.publicIdentity.displayName ?? '伙伴'}仍在工作`}><i /><i /><i /></span>}
                      {!receiptOnly && <div className="message-actions"><button className={copiedMessageId === message.id ? 'copied' : ''} type="button" onClick={() => void copyMessage(message)} title="复制本段对话">{copiedMessageId === message.id ? <Check size={14} /> : <Copy size={14} />}<span>{copiedMessageId === message.id ? '已复制' : '复制'}</span></button>{canQuote && <button type="button" onClick={() => quoteWholeMessage(message)} title="引用这段回复"><Quote size={14} /><span>引用</span></button>}{canRegenerate && mine && isLatestUser && <button type="button" onClick={() => { setEditingMessageId(message.id); setEditingText(message.content); }} title="编辑并重新生成"><Pencil size={14} /><span>编辑并重新生成</span></button>}{canRegenerate && !mine && isLatestAssistant && <button type="button" onClick={() => regenerateChatTurn(activeConversation.id)} title="重新生成"><RotateCcw size={14} /><span>重新生成</span></button>}</div>}
                    </div>
                    {mine && <Avatar name={userProfile.displayName} src={userAvatar} accent="#91a9cf" size="md" />}
                  </article>
                );
              })}
              {activeConversation.awaitingFirstResponse && activePartner
                && !chatRows.some(row => row.receiptOnly && row.message.clientMessageId === activeConversation.awaitingFirstResponse?.clientMessageId)
                && <div className="first-response-wait" role="status" aria-live="polite">
                <Avatar partnerId={activePartner.id} name={activePartner.publicIdentity.displayName} src={activePartner.publicIdentity.avatarDataUrl} accent={activePartner.accent} size="md" source={activePartner.sourceMode} />
                <div className="first-response-wait__content"><strong>{activeConversation.workStatus ? partnerStatusLabel(activeConversation.workStatus, activePartner.publicIdentity.displayName) : `${activePartner.publicIdentity.displayName} 正在整理思路`}</strong><span className="breathing-dots" aria-hidden="true"><i /><i /><i /></span></div>
              </div>}
              {activeConversation.runNotice?.restored && <div className={`run-notice run-notice--${activeConversation.runNotice.state}`} role="status"><CircleAlert size={15} /><span>{activeConversation.runNotice.message}，已恢复原回复。</span></div>}
              {historyWindow.detached && <div className="chat-history-controls">
                {historyWindow.hasNewer && <button type="button" className="secondary-button" disabled={historyWindow.loading}
                  onClick={() => void historyWindow.loadNewer(keepHistoryPosition)}>加载较新消息</button>}
                <button type="button" className="secondary-button" onClick={() => {
                  setHistoryJump(undefined);
                  followLatestMessageRef.current = true;
                  historyWindow.returnToLatest();
                }}>回到最新消息</button>
              </div>}
              <div ref={messageEndRef} />
            </div>
            {!historyWindow.detached && <JumpToLatest key={activeConversation.id} scrollRef={messageListRef} streaming={Boolean(activeConversation.activeRun)} partnerName={activePartner?.publicIdentity.displayName} onJump={() => { followLatestMessageRef.current = true; }} />}
            </div>
          </>) : (
            <div className="friendly-empty">
              <Sparkles size={34} />
              <h2>{activePartner ? `和 ${activePartner.publicIdentity.displayName} 开始一段新对话` : '添加你的第一位伙伴'}</h2>
              <p>{activePartner?.sourceMode === 'local_cli' && (activePartner.connectionKind === 'local_claude' || activePartner.connectionKind === 'local_codex') ? `将通过已授权目录连接本机 ${activePartner.adapterType === 'codex_cli' ? 'Codex' : 'Claude Code'}。` : activePartner?.sourceMode === 'api_partner' && !activePartner.isPrototype ? `将通过 ${activePartner.provider} · ${activePartner.model} 开始真实流式对话。` : '请先完成伙伴连接，再开始对话。'}</p>
              {!activePartner && <button className="primary-button" type="button" onClick={() => navigate('/settings/partners')}>添加伙伴</button>}
              {!partnerRemoved && activePartner && activePartner.sourceMode !== 'existing_thread' && <button className="primary-button" type="button" onClick={() => activePartner && ensureConversation(activePartner.id)}>新建对话</button>}
            </div>
          )}
        {activeConversation?.nativeThreadNotice && <div className={`run-notice run-notice--${activeConversation.nativeThreadNotice.state === 'error' ? 'failed' : 'cancelled'}`} role="status"><CircleAlert size={15} /><span>{activeConversation.nativeThreadNotice.message}</span></div>}
        {commandResult && <SessionCommandNotice result={commandResult} onDismiss={dismissCommandResult} />}
        {compaction && <SessionCommandNotice result={compaction} onDismiss={dismissCompaction} label="会话压缩状态" />}
        {activeConversation?.planMode === 'plan' && <div className="plan-mode-banner"><ListTodo size={14} /><span><strong>Plan 模式</strong>{activeConversation.planStatus === 'waiting_user' ? ' · 等待你的回答' : activeConversation.planStatus === 'ready' ? ' · 计划已就绪' : ' · 仅规划，不修改'}</span></div>}
        {activeConversation && handoffTargets.length > 0 && <div className="context-handoff-action"><button className="text-button" type="button" onClick={() => setHandoffOpen(true)}>带上下文去群聊</button></div>}
        {activeHandoff && <ContextHandoffDraftCard draft={activeHandoff} partnerName={activePartner?.publicIdentity.displayName ?? '伙伴'} disabled={Boolean(activeConversation?.activeRun)} onRemove={() => setContextHandoffDraft(undefined)} />}
        {handoffOpen && activeConversation && handoffTargets.length > 0 && <ContextHandoffDialog
          key={`handoff:${activeConversation.id}`} source={{ kind: 'single', id: activeConversation.id }} messages={activeConversation.messages}
          targets={handoffTargets} partners={state.partners} onClose={() => setHandoffOpen(false)} onStage={draft => {
            setContextHandoffDraft(draft);
            selectGroupChat(draft.target.id);
            navigate('/studio/discussion');
          }} />}
        <Composer
          key={cyberBossChat ? `${activeConversation?.id}:${cyberBossThreadId}` : activeConversation?.id ?? 'no-conversation'}
          draftKey={activeConversation ? `chat:${activeConversation.id}` : undefined}
          placeholder={canStageGuidance ? `输入补充要求，Enter 后暂存…` : nativeThreadUnavailable ? '原生线程暂不可用，请先查看上方提示' : workspaceMismatch ? '发送时将确认切换到当前工作区的新 session' : activeConversation?.isDisabled ? '这条会话已停用' : activeConversation ? `给 ${activePartner?.publicIdentity.displayName ?? '伙伴'} 发送消息…` : '请先新建一段对话'}
          onSend={sendWithAttachments}
          busy={Boolean(activeConversation?.activeRun) || compacting}
          allowBusySend={canStageGuidance && !compacting}
          pendingGuidance={pendingGuidance}
          pendingQuote={pendingQuote}
          onRemovePendingQuote={() => setPendingQuote(undefined)}
          onSendPendingGuidance={() => void sendPendingGuidance()}
          onDiscardPendingGuidance={discardPendingGuidance}
          pendingGuidanceSendDisabled={Boolean(activeConversation?.activeRun && (activeConversation.pendingAuthorization || activeConversation.pendingUserInput))}
          disabled={partnerRemoved || !activeConversation || activeConversation.isDisabled || nativeThreadUnavailable || compacting}
          attachmentsEnabled={attachmentsEnabled}
          allowLocalReferences={attachmentsEnabled ? true : undefined}
          attachmentCapabilities={activePartner?.attachmentCapabilities}
          cyberBossChat={cyberBossChat}
          cyberBossFileCapabilities={cyberBossFileCapabilities}
          attachmentDisabledReason="请先完成伙伴连接"
          permissionMode={activeConversation?.permissionMode ?? activePartner?.defaultPermissionMode ?? 'manual'}
          permissionDisabledReason={permissionDisabledReason}
          automaticPermissionAvailable={automaticPermissionAvailable}
          automaticPermissionDisabledReason={activePartner?.sourceMode === 'local_cli' && activePartner.adapterType === 'claude_code' ? '尚未确认当前 Claude 账号与模型支持 auto' : '当前伙伴不支持自动审批'}
          onPermissionModeChange={runtimeControls && activeConversation ? (mode) => setConversationPermissionMode(activeConversation.id, mode) : undefined}
          planMode={activeConversation?.planMode ?? 'default'}
          planAvailable={planAvailable}
          planDisabledReason={planDisabledReason}
          onPlanModeChange={runtimeControls && activeConversation ? (mode) => setConversationPlanMode(activeConversation.id, mode) : undefined}
          onSessionCommand={activeConversation && window.asteriumAgents?.executeSessionCommand ? (command) => executeChatCommand(activeConversation.id, command) : undefined}
          onCompactSession={activeConversation && runtimeControls ? () => void executeChatCommand(activeConversation.id, 'compact') : undefined}
          compactDisabledReason={compactDisabledReason}
          reloadDisabledReason={!runtimeControls ? '当前伙伴不支持星丛资料重读' : !activeConversation?.sessionId ? '先完成一轮对话后再重读' : pendingGuidance ? '请先处理暂存的中途消息' : workspaceMismatch ? '请先处理当前对话的工作区变更' : undefined}
          focusRequestKey={composerFocusKey}
          onCancel={compacting || (activePartner?.sourceMode === 'existing_thread' && !activePartner.capabilities?.cancellation) ? undefined : () => activeConversation && cancelChatRun(activeConversation.id)}
        />
        </section>
      </section>

      {previewTabs.length > 0 && <div className="rail-resizer rail-resizer--preview" role="separator" tabIndex={0} aria-label="调整聊天区与预览区宽度" aria-orientation="vertical" onPointerDown={(event) => startRailResize('preview', event)} onKeyDown={(event) => { if (event.key === 'ArrowLeft') setPreviewWidth((width) => clamp(width + 20, 320, 860)); if (event.key === 'ArrowRight') setPreviewWidth((width) => clamp(width - 20, 320, 860)); }} />}
      {previewTabs.length > 0 && <FilePreviewPane tabs={previewTabs} activeId={activePreviewId} onActive={setActivePreviewId} onClose={closePreview} onArtifactContextMenu={openArtifactMenu} />}

      <div hidden={rails.right} className="rail-resizer rail-resizer--right" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => startRailResize('right', event)} />

      <aside hidden={rails.right} className="glass-panel right-rail">
        <PartnerQuickCard
          key={activePartner?.id}
          partner={activePartner}
          conversation={activeConversation}
          projects={participatingProjects}
          onUpdatePartner={updatePartner}
          onUpdateWorkspaceGrants={updatePartnerWorkspaceGrants}
          codexModelPicker={activeConversation && activePartner?.sourceMode === 'local_cli' && activePartner.connectionKind === 'local_codex'
            && activePartner.codexRuntimeId && (activeConversation.partnerRootGrantId || activePartner.partnerRootGrantId)
            && window.asteriumAgents?.listCodexModels ? <CodexModelPicker
              key={JSON.stringify([activePartner.codexRuntimeId, activePartner.codexRuntime?.environment, activeConversation.partnerRootGrantId ?? activePartner.partnerRootGrantId])}
              partnerRootGrantId={activeConversation.partnerRootGrantId ?? activePartner.partnerRootGrantId}
              codexRuntimeId={activePartner.codexRuntimeId}
              codexRuntimeEnvironment={activePartner.codexRuntime?.environment}
              selection={activeConversation.codexModel}
              currentModel={activeConversation.runtimeModel?.model}
              disabled={Boolean(partnerRemoved || activeConversation.isDisabled || nativeThreadUnavailable || compacting)}
              onChange={selection => setConversationCodexModel(activeConversation.id, selection)}
            /> : undefined}
        />
        <section className={`side-section${collapsedResourceSections.artifacts ? ' side-section--collapsed' : ''}`}>
          <header><button className="side-section-toggle" type="button" aria-expanded={!collapsedResourceSections.artifacts} aria-controls="chat-artifact-list" aria-label={`${collapsedResourceSections.artifacts ? '展开' : '折叠'}文件与交付`} onClick={() => toggleResourceSection('artifacts')}><span><FileText size={20} />文件与交付</span>{collapsedResourceSections.artifacts ? <ChevronRight size={17} /> : <ChevronDown size={17} />}</button></header>
          {!collapsedResourceSections.artifacts && <div
            id="chat-artifact-list"
            className={`resource-list artifact-list${artifactScrollbarVisible ? ' artifact-list--scrollbar' : ''}`}
            aria-label="交付文件"
            onPointerMove={(event) => setArtifactScrollbarVisible(event.currentTarget.getBoundingClientRect().right - event.clientX <= 20)}
            onPointerLeave={() => setArtifactScrollbarVisible(false)}
          >
            {visibleDeliveries.map((file) => <div className="artifact-row" key={file.id} id={`chat-delivery-${file.id}`} tabIndex={-1} onContextMenu={(event) => openArtifactMenu(file.id, event, true)}>
              <button className="artifact-main" type="button" disabled={file.availability === 'missing' || file.availability === 'unavailable'} onClick={() => void openArtifact(file.id)} title={`预览 ${file.name}`}>
                <span className="resource-icon">{file.mediaType?.startsWith('image/') ? <FileImage /> : <FileText />}</span>
                <span>
                  <strong>{file.name}</strong>
                  <small className={file.availability === 'missing' ? 'artifact-missing' : ''}>{file.availability === 'missing' ? '原文件已删除，引用已失效' : `${file.registrationMethod === 'manual' ? '历史手动添加' : artifactSourceLabel(file.sourceKind, file.cached)} · ${formatBytes(file.sizeBytes)}`}</small>
                  {Number.isFinite(Date.parse(file.createdAt)) && <small><time dateTime={file.createdAt} title="最近一次交付">更新于 {formatAttachmentTime(file.createdAt)}</time></small>}
                </span>
              </button>
              <span className="artifact-actions"><button type="button" disabled={file.availability !== 'available'} onClick={() => void window.asteriumArtifacts?.open(file.artifactRef)} title="用系统应用打开"><ExternalLink size={14} /></button><button type="button" disabled={file.availability !== 'available'} onClick={() => void window.asteriumArtifacts?.reveal(file.artifactRef)} title="打开所在文件夹"><FolderOpen size={14} /></button></span>
            </div>)}
            {!visibleDeliveries.length && <p className="resource-empty">这段对话还没有生成文件</p>}
          </div>}
        </section>
        <section className={`side-section${collapsedResourceSections.attachments ? ' side-section--collapsed' : ''}`}>
          <header><button className="side-section-toggle" type="button" aria-expanded={!collapsedResourceSections.attachments} aria-controls="chat-attachment-list" aria-label={`${collapsedResourceSections.attachments ? '展开' : '折叠'}我的附件`} onClick={() => toggleResourceSection('attachments')}><span><Paperclip size={20} />我的附件</span>{collapsedResourceSections.attachments ? <ChevronRight size={17} /> : <ChevronDown size={17} />}</button></header>
          {!collapsedResourceSections.attachments && <div
            id="chat-attachment-list"
            className={`resource-list artifact-list${attachmentScrollbarVisible ? ' artifact-list--scrollbar' : ''}`}
            aria-label="我的附件"
            onPointerMove={(event) => setAttachmentScrollbarVisible(event.currentTarget.getBoundingClientRect().right - event.clientX <= 20)}
            onPointerLeave={() => setAttachmentScrollbarVisible(false)}
          >
            {attachmentGroups.map(({ sourceId, versions, latest, sendCount }) => <div className="attachment-source" key={sourceId}>
              <div className="artifact-row" onContextMenu={(event) => { event.preventDefault(); setArtifactMenu(null); setAttachmentMenu({ id: latest.id, x: event.clientX, y: event.clientY }); }}>
                {latest.localReference ?
                  <button className="artifact-main" type="button" disabled={latest.availability !== 'available'} onClick={() => void openUserAttachment(latest.id)} title="在文件夹中显示">
                    <span className="resource-icon"><FileText /></span>
                    <span><strong>{latest.name}</strong><small>{latest.availability === 'available' ? '本地引用' : '本地引用 · 原文件不可用'}</small></span>
                  </button>
                : <>
                <button className="artifact-main" type="button" disabled={latest.availability !== 'available'} onClick={() => void openUserAttachment(latest.id)} title={`预览最新版 ${latest.name}`}><span className="resource-icon">{latest.mediaType.startsWith('image/') ? <FileImage /> : <FileText />}</span><span><strong>{latest.name}</strong><small className={latest.availability !== 'available' || latest.sourceAvailability === 'missing' ? 'artifact-missing' : ''}>{latest.availability !== 'available' ? '附件快照不可用' : latest.sourceAvailability === 'missing' ? '原文件已失效 · 快照仍可用' : `${versions.length} 个版本 · 发送 ${sendCount} 次`}</small></span></button>
                <span className="artifact-actions"><button type="button" disabled={latest.availability !== 'available'} onClick={() => void window.asteriumAttachments?.open(latest.id, activeConversation!.id)} title="用系统应用打开快照"><ExternalLink size={14} /></button><button type="button" disabled={latest.sourceAvailability !== 'available'} onClick={() => void window.asteriumAttachments?.reveal(latest.id, activeConversation!.id)} title={latest.sourceAvailability === 'available' ? '打开原文件所在文件夹' : latest.sourceAvailability === 'missing' ? '原文件已失效' : '没有原文件路径'}><FolderOpen size={14} /></button><button type="button" onClick={() => setExpandedAttachmentSources((current) => ({ ...current, [sourceId]: !current[sourceId] }))} title="查看附件版本" aria-expanded={Boolean(expandedAttachmentSources[sourceId])}>{expandedAttachmentSources[sourceId] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button></span>
                </>}
              </div>
              {expandedAttachmentSources[sourceId] && <div className="attachment-version-list">{[...versions].reverse().map((version, index) => <div className="attachment-version" key={version.id} onContextMenu={(event) => { event.preventDefault(); setAttachmentMenu({ id: version.id, x: event.clientX, y: event.clientY }); }}><button type="button" disabled={version.availability !== 'available'} onClick={() => void openUserAttachment(version.id)}><span><strong>{index === 0 ? '最新版' : `版本 ${versions.length - index}`}</strong><small>{formatAttachmentTime(version.sentAt)} · {formatBytes(version.sizeBytes)}</small></span></button>{version.sends.map((send) => { const message = activeConversation?.messages.find((item) => item.id === send.messageId); return <small className="attachment-send-record" key={`${version.id}-${send.messageId}-${send.sentAt}`}>{formatAttachmentTime(send.sentAt)} · {message ? `消息：${message.content.slice(0, 28) || '仅附件'}`
                  : window.asteriumConversations?.readHistoryPage ? <button type="button" className="text-button" onClick={() => void revealHistoryMessage(send.messageId)}>查看发送消息</button>
                    : '对应消息已不在本地记录中'}</small>; })}</div>)}</div>}
            </div>)}
            {!attachmentGroups.length && <p className="resource-empty">这段对话还没有发送附件</p>}
          </div>}
        </section>
        <section className="side-section">
          <header><span><FolderKanban size={20} />参与中的项目</span><ChevronRight size={18} /></header>
          <div className="resource-list">
            {participatingProjects.map((project) => (
              <button type="button" key={project.id} onClick={() => { selectProject(project.id); navigate('/studio/workspace'); }} title="在工作室中打开项目">
                <span className="resource-icon"><Archive size={20} /></span>
                <span><strong>{project.name}</strong><small>{project.status === 'active' ? '进行中' : '已暂停'} · {project.progress}%</small></span>
                <MoreHorizontal size={16} />
              </button>
            ))}
            {!participatingProjects.length && <p className="resource-empty">当前伙伴尚未参与项目</p>}
          </div>
        </section>
        <button className="diary-launcher" type="button" disabled={!activePartner || Boolean(activePartner.managedDataDeletedAt)} onClick={() => setOverlay('diary')} aria-label={`打开${activePartner?.publicIdentity.displayName ?? '伙伴'}的日记本`}>
          <span className="diary-book" aria-hidden="true"><span /><span /><span /></span>
          <span className="diary-launcher-copy"><strong>伙伴日记本</strong><small>翻开{activePartner?.publicIdentity.displayName ?? '伙伴'}的日常</small></span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </aside>

      {overlay === 'diary' && activePartner && <DiaryModal key={activePartner.id} partnerId={activePartner.id} onClose={() => setOverlay(null)} />}

      {artifactMenu && artifactMenuFile && (() => {
        const file = artifactMenuFile;
        const unavailable = file.availability !== 'available';
        return <div className="artifact-context-menu artifact-delivery-menu" aria-label="交付文件操作" style={contextMenuPosition(artifactMenu.x, artifactMenu.y, artifactMenu.fromList ? 212 : 225)} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" disabled={unavailable || !window.asteriumArtifacts?.openInBrowser} onClick={() => void runArtifactAction(file, 'openInBrowser', '无法在默认浏览器中打开，请确认交付文件仍可用。')}><Globe2 size={14} />用默认浏览器打开</button>
          <button type="button" disabled={unavailable} onClick={() => void runArtifactAction(file, 'reveal', '无法打开所在文件夹，请确认交付文件仍可用。')}><FolderOpen size={14} />打开文件所在文件夹</button>
          {!artifactMenu.fromList && <button type="button" onClick={() => locateDelivery(file)}><FileSearch size={14} />在文件与交付中定位</button>}
          {file.sourceKind === 'local_path' && <button type="button" onClick={() => void runArtifactAction(file, 'copyPath', '无法复制交付文件路径。')}><Copy size={14} />复制路径</button>}
          <hr />
          <button type="button" disabled={unavailable} onClick={() => void runArtifactAction(file, 'exportAs', '文件另存失败，请确认文件可用且目标位置可写。')}><Save size={14} />文件另存为</button>
          <button type="button" disabled={unavailable} onClick={() => { setArtifactMenu(null); openSaveToProject(file.id); }}><FolderKanban size={14} />保存到项目</button>
          {artifactMenu.fromList && <><hr /><button className="danger" type="button" onClick={() => void beginArtifactDeletion(file.id)}><Trash2 size={14} />删除文件</button></>}
        </div>;
      })()}
      {artifactActionError && artifactActionError.conversationId === activeConversationId && <div className="session-command-notice session-command-notice-header artifact-action-error" role="alert">
        <span>{artifactActionError.message}</span><button type="button" aria-label="关闭文件操作提示" onClick={() => setArtifactActionError(undefined)}><X size={14} /></button>
      </div>}
      {attachmentMenu && (() => {
        const file = userAttachments.find((item) => item.id === attachmentMenu.id);
        return <div className="artifact-context-menu" style={contextMenuPosition(attachmentMenu.x, attachmentMenu.y)} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" disabled={file?.sourceAvailability !== 'available'} onClick={() => { if (file && activeConversation) void window.asteriumAttachments?.copyPath(file.id, activeConversation.id); setAttachmentMenu(null); }}><Copy size={14} />复制原文件路径</button>
          {!file?.localReference && <>
            <button type="button" disabled={file?.availability !== 'available'} onClick={() => { if (file && activeConversation) void window.asteriumAttachments?.exportAs(file.id, activeConversation.id); setAttachmentMenu(null); }}><Save size={14} />文件另存为</button>
            <button type="button" disabled={file?.availability !== 'available'} onClick={() => { if (file) openAttachmentSaveToProject(file.id); setAttachmentMenu(null); }}><FolderKanban size={14} />保存到项目</button>
          </>}
        </div>;
      })()}
      {quoteMenu && <div className="artifact-context-menu quote-context-menu" role="menu" aria-label="引用选中内容" style={contextMenuPosition(quoteMenu.x, quoteMenu.y)} onPointerDown={(event) => event.stopPropagation()}><button type="button" role="menuitem" onClick={() => { setPendingQuote(quoteMenu.quote); setQuoteMenu(null); setComposerFocusKey((value) => value + 1); }}><Quote size={14} />引用选中内容</button></div>}

      {fileDeletionInspection && <FileDeletionModal inspection={fileDeletionInspection} busy={fileDeletionBusy} error={fileDeletionError} onClose={() => { if (!fileDeletionBusy) { setArtifactDeletionTarget(undefined); setFileDeletionInspection(undefined); setFileDeletionError(''); } }} onConfirm={() => void confirmArtifactDeletion()} />}

      {overlay === 'save-artifact' && <Modal title="保存到项目" description="文件会保存到项目文件夹，并显示在「项目文件交付」。" onClose={() => { if (!artifactProjectBusy) { setArtifactProjectTarget(null); setOverlay(null); } }}><div className="modal-body"><label className="modal-field">选择项目<select value={artifactProjectId} onChange={(event) => { setArtifactProjectId(event.target.value); setArtifactProjectError(''); }}><option value="">新建项目…</option>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{!artifactProjectId && <label className="modal-field">新项目名称<input value={newArtifactProjectName} onChange={(event) => { setNewArtifactProjectName(event.target.value); setArtifactProjectError(''); }} autoFocus /></label>}{artifactProjectError && <p className="modal-error">{artifactProjectError}</p>}</div><footer className="modal-footer"><button className="secondary-button" type="button" disabled={artifactProjectBusy} onClick={() => { setArtifactProjectTarget(null); setOverlay(null); }}>取消</button><button className="primary-button" type="button" disabled={artifactProjectBusy || (!artifactProjectId && !newArtifactProjectName.trim())} onClick={() => void saveArtifactToProject()}>{artifactProjectBusy ? '正在保存…' : '保存到项目'}</button></footer></Modal>}

      {workspaceSendRequest && (
        <Modal title="这条对话绑定了另一个工作区" description="请选择继续使用旧原生线程，或在当前 cwd 下为这条可见对话建立独立线程。" onClose={closeWorkspaceDecision}>
          <div className="modal-body">
            <p><strong>旧 cwd：</strong>{activeConversation?.partnerRoot || '不可用'}</p>
            <p><strong>当前 cwd：</strong>{activePartner?.sourceMode === 'local_cli' ? activePartner.partnerRoot || '不可用' : '不可用'}</p>
          </div>
          <footer className="modal-footer">
            <button className="secondary-button" type="button" disabled={workspaceDecisionBusy} onClick={closeWorkspaceDecision}>取消</button>
            <button className="secondary-button" type="button" disabled={workspaceDecisionBusy || !activeConversation?.partnerRootGrantId} onClick={() => void chooseWorkspaceDecision('switch_to_conversation_cwd')}>切回旧 cwd</button>
            <button className="primary-button" type="button" disabled={workspaceDecisionBusy} onClick={() => void chooseWorkspaceDecision('new_session_in_current_cwd')}>{workspaceDecisionBusy ? '正在切换…' : '在当前 cwd 新建线程'}</button>
          </footer>
        </Modal>
      )}

      {overlay === 'new-chat' && (
        <Modal title="创建对话" description="先指定一位伙伴，新对话会自动归入 TA 的分组。" onClose={() => setOverlay(null)}>
          <div className="modal-body">
            <div className="agent-choice-list" role="radiogroup" aria-label="选择伙伴">
          {newChatPartners.map((partner) => (
                <button className={newChatPartnerId === partner.id ? 'active' : ''} type="button" role="radio" aria-checked={newChatPartnerId === partner.id} key={partner.id} onClick={() => setNewChatPartnerId(partner.id)}>
                  <Avatar partnerId={partner.id} name={partner.publicIdentity.displayName} src={partner.publicIdentity.avatarDataUrl} accent={partner.accent} size="sm" status source={partner.sourceMode} selected={newChatPartnerId === partner.id} />
                  <span><strong>{partner.publicIdentity.displayName}</strong><small>{partner.publicIdentity.introduction}</small></span>
                  {newChatPartnerId === partner.id && <span className="choice-dot" />}
                </button>
              ))}
            </div>
            <label className="modal-field">对话名称（可选）
              <input value={newChatTitle} onChange={(event) => setNewChatTitle(event.target.value)} placeholder="例如：周一计划整理" maxLength={50} />
            </label>
          </div>
          <footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setOverlay(null)}>取消</button><button className="primary-button" type="button" disabled={!newChatPartnerId} onClick={submitNewChat}>创建对话</button></footer>
        </Modal>
      )}

      {overlay === 'rename-chat' && (
        <Modal title="修改对话标题" description="只修改星丛里的显示名称，不会改变伙伴原线程。" onClose={() => setOverlay(null)}>
          <div className="modal-body"><label className="modal-field">对话标题<input value={conversationTitle} onChange={(event) => setConversationTitle(event.target.value)} maxLength={50} autoFocus /></label></div>
          <footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setOverlay(null)}>取消</button><button className="primary-button" type="button" disabled={!conversationTitle.trim()} onClick={() => { renameConversation(conversationTargetId, conversationTitle); setOverlay(null); }}>保存标题</button></footer>
        </Modal>
      )}

      {overlay === 'archive-chat' && (
        <Modal title="归档这段对话？" description="归档后会从单聊页隐藏，可在设置的“归档管理 · 单聊”中恢复或永久删除；不会改变 Codex、Claude Code 或其他上游线程。" onClose={() => !lifecycleBusy && setOverlay(null)}>
          <div className="modal-body"><p>将归档「{conversationTitle}」。</p></div>
          {lifecycleError && <p className="form-error">{lifecycleError}</p>}
          <footer className="modal-footer"><button className="secondary-button" type="button" disabled={lifecycleBusy} onClick={() => setOverlay(null)}>取消</button><button className="primary-button" type="button" disabled={lifecycleBusy} onClick={() => void confirmArchive()}>{lifecycleBusy ? '正在归档…' : '确认归档'}</button></footer>
        </Modal>
      )}

      {overlay === 'archive-partner' && (() => {
        const partner = state.partners.find((item) => item.id === partnerArchiveTargetId);
        const count = state.conversations.filter((conversation) => conversation.partnerId === partnerArchiveTargetId && !conversation.isArchived).length;
        return <Modal title="归档伙伴的全部对话？" description="伙伴的连接已移除；这会把其仍显示的所有对话一次移入归档，不会删除上游线程。" onClose={() => setOverlay(null)}>
          <div className="modal-body"><p>将归档 {partner?.publicIdentity.displayName ?? '该伙伴'} 的 {count} 段对话。</p></div>
          <footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setOverlay(null)}>取消</button><button className="primary-button" type="button" onClick={() => { archivePartnerConversations(partnerArchiveTargetId); setOverlay(null); }}>一键归档全部</button></footer>
        </Modal>
      })()}

    </main>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readRailWidth(key: string, fallback: number, min: number, max: number) {
  const stored = Number(window.localStorage.getItem(key));
  return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : fallback;
}

function readCollapsedPartners(activePartnerId: string) {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem('asterium.chat.collapsedPartners') ?? '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) return { ...(stored as Record<string, boolean>), [activePartnerId]: false };
  } catch { /* use first-run defaults */ }
  return { [activePartnerId]: false };
}

function readCollapsedResourceSections() {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem('asterium.chat.collapsedResourceSections') ?? '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      const value = stored as Record<string, unknown>;
      return { artifacts: value.artifacts === true, attachments: value.attachments === true };
    }
  } catch { /* use expanded defaults */ }
  return { artifacts: false, attachments: false };
}

function formatBytes(value?: number) {
  if (!value) return '对话产物';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function latestDeliveriesBySource(artifacts: ConversationArtifact[]) {
  const latest = new Map<string, ConversationArtifact>();
  for (const artifact of artifacts) {
    const key = deliverySourceKey(artifact);
    const previous = latest.get(key);
    if (!previous || artifact.createdAt >= previous.createdAt) latest.set(key, artifact);
  }
  return [...latest.values()];
}

function deliverySourceKey(artifact: ConversationArtifact) {
  return artifact.sourceKind === 'local_path' && artifact.localSourceKey ? `local:${artifact.localSourceKey}` : `record:${artifact.id}`;
}

function groupUserAttachments(attachments: ConversationAttachmentInfo[]) {
  const groups = new Map<string, ConversationAttachmentInfo[]>();
  for (const attachment of attachments) groups.set(attachment.sourceId, [...(groups.get(attachment.sourceId) ?? []), attachment]);
  return [...groups.entries()].map(([sourceId, versions]) => {
    const ordered = [...versions].sort((left, right) => left.sentAt.localeCompare(right.sentAt));
    return { sourceId, versions: ordered, latest: ordered.at(-1)!, sendCount: ordered.reduce((total, item) => total + item.sends.length, 0) };
  }).sort((left, right) => left.latest.sentAt.localeCompare(right.latest.sentAt));
}

function formatAttachmentTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function contextMenuPosition(x: number, y: number, height = 132): CSSProperties {
  return { left: Math.max(8, Math.min(x, window.innerWidth - 210)), top: Math.max(8, Math.min(y, window.innerHeight - height)) };
}

function artifactSourceLabel(source?: 'local_path' | 'remote_ref' | 'content', cached?: boolean) {
  if (source === 'local_path') return '由伙伴交付';
  if (source === 'remote_ref') return cached ? '服务器文件 · 已缓存' : '服务器文件 · 按需获取';
  if (source === 'content') return cached ? '网络内容 · 已缓存' : '网络内容 · 按需获取';
  return '对话交付';
}

function artifactPreviewError(error: unknown, fileName: string) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('ARTIFACT_TOO_LARGE')) {
    return /\.html?$/i.test(fileName) ? '这个 HTML 文件超过 20 MB，暂时无法在星丛中预览。' : '这个文件超过当前格式的预览上限，请使用系统应用打开。';
  }
  return message || '无法读取文件';
}

function projectTransferError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('PROJECT_WORKSPACE_NOT_READY')) return '这个旧项目还没有真实文件夹，请先在工作室中初始化项目目录。';
  if (message.includes('PROJECT_CREATE_LOCATION_CHANGED')) return '项目保存位置已变化，请重新确认。';
  if (message.includes('PROJECT_LOCATION_SELECTION_EXPIRED')) return '目录选择已失效，请重新选择。';
  if (message.includes('PROJECT_DIRECTORY')) return '无法使用这个项目文件夹，请检查目录权限或换一个位置。';
  return message && !message.includes('PROJECT_SAVE_UNAVAILABLE') ? message : '暂时无法保存到项目，请稍后重试。';
}

interface ChatMessageRow {
  key: string;
  message: Message;
  batches: DelegationBatchView[];
  receiptOnly?: true;
}

function buildChatRows(conversation: Conversation | undefined, batches: DelegationBatchView[]): ChatMessageRow[] {
  if (!conversation) return [];
  const rows = conversation.messages.map((message, index): ChatMessageRow => ({ key: `${message.id}:${index}`, message, batches: [] }));
  const pendingRows = new Map<number, ChatMessageRow[]>();

  for (const batch of batches) {
    if (batch.conversationId !== conversation.id || batch.partnerId !== conversation.partnerId) continue;
    const sourceIndex = conversation.messages.findIndex(message => message.id === batch.messageId && isAsteriumUser(message.authorId));
    const source = conversation.messages[sourceIndex];
    if (!source) continue;

    // Regenerating a turn reuses the message ID but gives it a new client message ID.
    const sourceRunId = !source.clientMessageId || source.clientMessageId === batch.turnId ? source.runId : undefined;
    const runId = sourceRunId ?? (conversation.activeRun?.clientMessageId === batch.turnId ? conversation.activeRun.runId : undefined);
    const response = runId && rows.find(({ message }, index) => index > sourceIndex && message.authorId === batch.partnerId
      && (message.runId === runId || message.runId?.startsWith(`${runId}:before-guidance:`)));
    if (response) {
      response.batches.push(batch);
      continue;
    }

    // Render the receipt at the source turn even when the assistant has no message yet.
    const replies = pendingRows.get(sourceIndex) ?? [];
    const existing = replies.find(row => row.message.clientMessageId === batch.turnId);
    if (existing) {
      existing.batches.push(batch);
      continue;
    }
    const id = `delegation-receipt:${batch.turnId}`;
    const createdAt = new Date(batch.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    replies.push({ key: id, message: { id, authorId: batch.partnerId, content: '', clientMessageId: batch.turnId, createdAt }, batches: [batch], receiptOnly: true });
    pendingRows.set(sourceIndex, replies);
  }

  return pendingRows.size ? rows.flatMap((row, index) => [row, ...(pendingRows.get(index) ?? [])]) : rows;
}

function deliveryLabel(status?: 'sending' | 'awaiting_confirmation' | 'delivered' | 'failed') {
  return { sending: '发送中', awaiting_confirmation: '待确认', delivered: '已送达', failed: '发送失败' }[status ?? 'delivered'];
}

const delegationReviewReason: Record<string, string> = {
  DELEGATION_REVIEW_UNCERTAIN: '还没有确认回执，星丛会查询原任务。',
  DELEGATION_REVIEW_BUSY: '伙伴的原线程正忙，可以稍后重试。',
  DELEGATION_REVIEW_THREAD_CHANGED: '伙伴的原线程已切换，请确认后发起新的复核。',
  DELEGATION_REVIEW_UNAVAILABLE: '该伙伴当前无法接收星丛复核。',
  DELEGATION_REVIEW_FILE_UNREADABLE: '伙伴无法读取这份方案文件。',
  DELEGATION_REVIEW_MARKDOWN_REQUIRED: '复核需要一份 UTF-8 Markdown 文件。',
  DELEGATION_REVIEW_FILE_SIZE: '方案文件须为非空且不超过 160 KB。',
  DELEGATION_REVIEW_MESSAGE_TOO_LONG: '转交说明太长，请将方案内容放在 Markdown 文件里。',
  DELEGATION_REVIEW_SINGLE_TARGET: '每次复核只能发给一位接回伙伴。',
  DELEGATION_REVIEW_FAILED: '伙伴未能完成这次复核。',
};
