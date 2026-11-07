import { supportsContextHandoff } from '../app/singleChatRuntime';
import { ContextHandoffDialog, ContextHandoffDraftCard } from '../components/chat/ContextHandoffDialog';
import { useCollapsibleRails } from '../components/layout/useCollapsibleRails';
import { WorkspaceShortcuts } from '../components/layout/WorkspaceShortcuts';
import { useProjectRunChanges } from '../components/studio/useProjectRunChanges';
import { RunChangeSummary } from '../components/studio/RunChangeSummary';
import type { ProjectRunChange } from '../../shared/projectRunChanges';
import { ProjectBrowserPane, type BrowserTab } from '../components/studio/ProjectBrowserPane';
import { ProjectFileTree } from '../components/studio/ProjectFileTree';
import { useProjectBrowseRefresh } from '../components/studio/useProjectBrowseRefresh';
import { useStudioPreview } from '../components/studio/useStudioPreview';
import { MessageAttachmentCards } from '../components/chat/MessageAttachmentCards';
import { studioAttachmentConversationId } from '../../shared/studioRuntime';
import type { PendingMessageAttachment } from '../../shared/agentProtocol';
import {
  Archive, ArchiveRestore, AtSign, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleCheck, FileText, FolderKanban, FolderOpen, Gamepad2, Home, Loader2, RefreshCw,
  Flame, Hand, LockKeyhole, MapPin, MessageSquare, MessageSquarePlus, Mic, MicOff, MoreHorizontal, Pause, Pencil, Plane, Play, Plus, RotateCcw,
  NotebookPen, ShieldCheck, Sparkles, Square, StickyNote, Trash2, Upload, UserPlus, UsersRound,
} from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { usePrototype } from '../app/PrototypeProvider';
import type { MemorySourceNavigationState } from '../app/memorySourceNavigation';
import { isAsteriumUser } from '../../shared/identity';
import { sanitizePngDataUrl } from '../app/pngDataUrl';
import { friendlyRuntimeErrorMessage } from '../app/runtimeErrorPresentation';
import { ASTERIUM_LOGO_DATA_URL } from '../assets/asteriumLogoData';
import { Brand, MainHeader } from '../components/layout/AppNavigation';
import { StudioComposer, type StudioMentionOption } from '../components/studio/StudioComposer';
import { StudioMemberManager } from '../components/studio/StudioMemberManager';
import { Avatar } from '../components/ui/Avatar';
import { Modal } from '../components/ui/Modal';
import { FileDeletionModal } from '../components/ui/FileDeletionModal';
import { fileDeletionErrorMessage } from '../app/fileDeletionPresentation';
import { TurnTimeline } from '../components/chat/TurnTimeline';
import { JumpToLatest } from '../components/chat/JumpToLatest';
import { MarkdownContent } from '../components/chat/MarkdownContent';
import { projectTaskStatusLabel, taskAttemptFailureLabel, taskStageVoiceItems } from './studioTaskPresentation';
import type { GroupChat, Partner, Project, TaskItem } from '../types/domain';
import type { FileDeletionInspection, ProjectLocationSelection } from '../../shared/projectWorkspace';
import type { ProjectExecutionPolicy, ProjectPermissionMode } from '../../shared/projectExecutionPolicy';
import type { ProjectStatus, ProjectTaskCompletionRule, ProjectTaskMethodTemplate, ProjectTaskStatus, ProjectTaskWorkRole } from '../../shared/projectDomain';
import {
  DEFAULT_PROJECT_WORK_ROLE_GROUP,
  PROJECT_WORK_ROLE_GROUPS,
  projectWorkRoleSnapshot,
  type ProjectWorkRoleCatalog,
  type ProjectWorkRoleDefinition,
} from '../../shared/projectRoles';
import {
  projectMethodTemplateSnapshot,
  type ProjectMethodTemplateDefinition,
  type ProjectWorkflow,
  type ProjectWorkflowCatalog,
  type ProjectWorkflowDraftNode,
  type ProjectWorkflowTemplateSummary,
} from '../../shared/projectWorkflows';
import type { ProjectTaskExecutionSnapshot, TaskAttempt } from '../../shared/projectTaskExecution';
import type { ProjectWorkflowGeneration } from '../../shared/projectWorkflowGeneration';
import type { StudioMention, StudioRoomSettings } from '../../shared/studioRuntime';
import type { StudioNote } from '../../shared/studioNotes';
import type { ProjectNotebook } from '../../shared/projectNotebook';

const projectIcons = [Home, Plane, Gamepad2];

const TASK_STATUS_OPTIONS = [
  ['todo', '待处理'],
  ['in_progress', '进行中'],
  ['blocked', '受阻'],
  ['review', '已提交/待处理'],
  ['completed', '已完成'],
  ['cancelled', '已取消'],
] as const satisfies ReadonlyArray<readonly [ProjectTaskStatus, string]>;

type TaskFilter = 'all' | ProjectTaskStatus;

interface TaskDraft {
  code: string;
  title: string;
  description: string;
  assigneeId: string;
  status: ProjectTaskStatus;
  dependencyIds: string[];
  acceptanceCriteria: string;
  note: string;
  completionRuleType: ProjectTaskCompletionRule['type'];
  reviewerPartnerId: string;
  autoReworkLimit: number;
  workRole?: ProjectTaskWorkRole;
  reviewWorkRole?: ProjectTaskWorkRole;
  methodTemplate?: ProjectTaskMethodTemplate;
}

const EMPTY_TASK_DRAFT: TaskDraft = {
  code: '', title: '', description: '', assigneeId: '', status: 'todo', dependencyIds: [], acceptanceCriteria: '', note: '',
  completionRuleType: 'executor_submit', reviewerPartnerId: '', autoReworkLimit: 2,
};

interface WorkRoleDraft {
  scope: 'global' | 'project';
  group: string;
  name: string;
  description: string;
  responsibilities: string;
  prompt: string;
}

const EMPTY_WORK_ROLE_DRAFT: WorkRoleDraft = { scope: 'project', group: '项目中期', name: '', description: '', responsibilities: '', prompt: '' };

const PROJECT_PERMISSION_OPTIONS = [
  { mode: 'read_only', label: '只读', description: '项目伙伴只读取与分析，不执行修改', icon: LockKeyhole },
  { mode: 'manual', label: '手动审批', description: '变更操作继续使用现有逐次审批', icon: Hand },
  { mode: 'full', label: '完整权限', description: '任务不中断；工作区增删和命令自动执行', icon: Flame },
] as const satisfies ReadonlyArray<{ mode: ProjectPermissionMode; label: string; description: string; icon: typeof LockKeyhole }>;

function projectPermissionOption(mode: ProjectPermissionMode) {
  return PROJECT_PERMISSION_OPTIONS.find((option) => option.mode === mode) ?? PROJECT_PERMISSION_OPTIONS[1];
}

export function StudioPage() {
  const rails = useCollapsibleRails('studio');
  const { mode = 'discussion' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    state, selectProject, createProject, updateProject, createProjectTask, updateProjectTask, removeProjectTask, removeProject, initializeProjectWorkspace, selectGroupChat, createGroupChat, updateGroupChat, setGroupMembers, setProjectMembers,
    archiveGroupChat, sendStudioMessage, studioRooms, studioInteractions, setStudioMuted, cancelStudioRound,
    contextHandoffDraft, setContextHandoffDraft, selectConversation,
    setStudioSettings, resolveStudioDiscussion, resolveStudioAuthorization, resolveStudioUserInput,
  } = usePrototype();
  const initialGroupChat = state.groupChats.find((item) => item.id === state.activeGroupChatId && !item.archivedAt)
    ?? state.groupChats.find((item) => !item.archivedAt);
  const openMemberPickerOnEntry = Boolean((location.state as { openMemberPicker?: boolean } | null)?.openMemberPicker);
  const memorySourceTarget = (location.state as MemorySourceNavigationState | null)?.memorySourceTarget;
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [showMembers, setShowMembers] = useState(openMemberPickerOnEntry);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set([state.activeProjectId || state.projects[0]?.id].filter(Boolean)));
  const [openHeaderMenu, setOpenHeaderMenu] = useState<'speaking' | 'permission'>();
  const [projectExecutionPolicy, setProjectExecutionPolicy] = useState<ProjectExecutionPolicy>();
  const [projectPermissionBusy, setProjectPermissionBusy] = useState(false);
  const [projectPermissionError, setProjectPermissionError] = useState('');
  const [projectSummaryOpen, setProjectSummaryOpen] = useState(true);
  const [projectFilesOpen, setProjectFilesOpen] = useState(true);
  const [projectFilesScrollbarVisible, setProjectFilesScrollbarVisible] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [editingTask, setEditingTask] = useState<TaskItem | 'new'>();
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(EMPTY_TASK_DRAFT);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [taskScrollTargetId, setTaskScrollTargetId] = useState<string>();
  const notificationTaskId = (location.state as { notificationTaskId?: string } | null)?.notificationTaskId;
  useEffect(() => {
    if (!notificationTaskId) return;
    const frame = requestAnimationFrame(() => {
      setFilter('all'); setTaskScrollTargetId(notificationTaskId);
      navigate(location.pathname, { replace: true, state: { ...location.state, notificationTaskId: undefined } });
    });
    return () => cancelAnimationFrame(frame);
  }, [notificationTaskId, location.pathname, location.state, navigate]);
  const [taskExecutions, setTaskExecutions] = useState<ProjectTaskExecutionSnapshot>({ version: 1, attempts: [], events: [] });
  const [taskExecutionBusy, setTaskExecutionBusy] = useState<string>();
  const [taskExecutionError, setTaskExecutionError] = useState('');
  const [roleCatalog, setRoleCatalog] = useState<ProjectWorkRoleCatalog>();
  const [roleCatalogError, setRoleCatalogError] = useState('');
  const [showRoleManager, setShowRoleManager] = useState(false);
  const [editingRole, setEditingRole] = useState<ProjectWorkRoleDefinition | 'new'>();
  const [roleDraft, setRoleDraft] = useState<WorkRoleDraft>(EMPTY_WORK_ROLE_DRAFT);
  const [roleBusy, setRoleBusy] = useState(false);
  const [roleError, setRoleError] = useState('');
  const [roleDeleteTarget, setRoleDeleteTarget] = useState<ProjectWorkRoleDefinition>();
  const [workflowCatalog, setWorkflowCatalog] = useState<ProjectWorkflowCatalog>();
  const [workflows, setWorkflows] = useState<ProjectWorkflow[]>([]);
  const [showWorkflowManager, setShowWorkflowManager] = useState(false);
  const [showWorkflowTemplates, setShowWorkflowTemplates] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<ProjectWorkflow>();
  const [workflowActivationId, setWorkflowActivationId] = useState('');
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowError, setWorkflowError] = useState('');
  const [workflowDeleteTarget, setWorkflowDeleteTarget] = useState<ProjectWorkflow>();
  const [workflowTemplateDialog, setWorkflowTemplateDialog] = useState<'new' | 'update'>();
  const [workflowTemplateName, setWorkflowTemplateName] = useState('');
  const [workflowTemplateDescription, setWorkflowTemplateDescription] = useState('');
  const [workflowTemplateDeleteTarget, setWorkflowTemplateDeleteTarget] = useState<ProjectWorkflowTemplateSummary>();
  const [workflowGenerations, setWorkflowGenerations] = useState<ProjectWorkflowGeneration[]>([]);
  const [showWorkflowGeneration, setShowWorkflowGeneration] = useState(false);
  const [workflowGenerationPlannerId, setWorkflowGenerationPlannerId] = useState('');
  const [workflowGenerationMessageIds, setWorkflowGenerationMessageIds] = useState<string[]>([]);
  const [activeWorkflowGenerationId, setActiveWorkflowGenerationId] = useState<string>();
  const [workflowGenerationBusy, setWorkflowGenerationBusy] = useState(false);
  const [workflowGenerationError, setWorkflowGenerationError] = useState('');
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [projectChoice, setProjectChoice] = useState<'existing' | 'new'>('new');
  const [selectedProjectId, setSelectedProjectId] = useState(state.activeProjectId || state.projects[0]?.id || '');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [projectLocation, setProjectLocation] = useState<ProjectLocationSelection | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [projectError, setProjectError] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [studioSendError, setStudioSendError] = useState('');
  const [retryingProjectUploads, setRetryingProjectUploads] = useState(false);
  const [editingGroup, setEditingGroup] = useState<GroupChat>();
  const [editingProject, setEditingProject] = useState<Project>();
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<Project>();
  const [memberRemoveTarget, setMemberRemoveTarget] = useState<Partner>();
  const [memberMenu, setMemberMenu] = useState<{ partnerId: string; x: number; y: number }>();
  const [projectFileMenu, setProjectFileMenu] = useState<{ fileId: string; x: number; y: number }>();
  const [fileDeletionInspection, setFileDeletionInspection] = useState<FileDeletionInspection>();
  const [fileDeletionBusy, setFileDeletionBusy] = useState(false);
  const [fileDeletionError, setFileDeletionError] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftMembers, setDraftMembers] = useState<string[]>(openMemberPickerOnEntry ? [...(initialGroupChat?.memberIds ?? [])] : []);
  const [projectDraftName, setProjectDraftName] = useState('');
  const [projectDraftDescription, setProjectDraftDescription] = useState('');
  const [projectDraftStatus, setProjectDraftStatus] = useState<ProjectStatus>('active');
  const [projectDraftProgress, setProjectDraftProgress] = useState(0);
  const [projectDraftTags, setProjectDraftTags] = useState('');
  const [projectDraftAvatar, setProjectDraftAvatar] = useState<string>();
  const [projectDraftMembers, setProjectDraftMembers] = useState<string[]>([]);
  const [notesOpen, setNotesOpen] = useState(true);
  const [noteArchiveOpen, setNoteArchiveOpen] = useState(false);
  const [notes, setNotes] = useState<StudioNote[]>([]);
  const [noteDraft, setNoteDraft] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string>();
  const [noteDeleteTarget, setNoteDeleteTarget] = useState<StudioNote>();
  const [notebookTarget, setNotebookTarget] = useState<Partner>();
  const [projectNotebook, setProjectNotebook] = useState<ProjectNotebook>();
  const [projectNotebookDraft, setProjectNotebookDraft] = useState('');
  const [projectNotebookBusy, setProjectNotebookBusy] = useState(false);
  const [projectNotebookError, setProjectNotebookError] = useState('');
  const projectAvatarInput = useRef<HTMLInputElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const keepAtBottomRef = useRef(true);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>();
  const [leftRailWidth, setLeftRailWidth] = useState(() => readRailWidth('asterium.studio.leftRailWidth', 260, 210, 340));
  const [rightRailWidth, setRightRailWidth] = useState(() => readRailWidth('asterium.studio.rightRailWidth', 286, 230, 380));
  const project = state.projects.find((item) => item.id === state.activeProjectId) ?? state.projects[0];
  const workflowDrafts = workflows.filter((workflow) => workflow.status === 'draft');
  const workflowRuns = workflows.filter((workflow) => workflow.status !== 'draft');
  const roleGroupOptions = workRoleGroupNames(roleCatalog?.roles ?? []);
  const editingSourceTemplate = workflowCatalog?.templates.find((template) => template.kind === 'project' && template.id === editingWorkflow?.sourceTemplate?.templateId);
  const projectTaskIds = new Set(project?.tasks.map((task) => task.id) ?? []);
  const projectGroups = state.groupChats.filter((item) => item.projectId === project?.id && !item.archivedAt);
  const groupChat = state.groupChats.find((item) => item.id === state.activeGroupChatId && item.projectId === project?.id && !item.archivedAt) ?? projectGroups[0];
  const members = state.partners.filter((partner) => groupChat?.memberIds.includes(partner.id));
  const activePartners = state.partners.filter((partner) => !partner.isRemoved);
  const userProfile = state.userProfile;
  const userAvatar = userProfile.avatarDataUrl ?? ASTERIUM_LOGO_DATA_URL;
  const isWork = mode === 'workspace';
  const preview = useStudioPreview(project?.id);
  const runChanges = useProjectRunChanges(project?.id);
  const [selectedChange, setSelectedChange] = useState<ProjectRunChange>();
  if (selectedChange && selectedChange.projectId !== project?.id) setSelectedChange(undefined);
  const viewRunChange = (change: ProjectRunChange) => { if (window.innerWidth <= 1900) preview.minimize(); setSelectedChange(change); setBrowserState((previous) => ({ ...previous, projectId: change.projectId, open: true })); };
  const [browserState, setBrowserState] = useState<{ projectId?: string; open: boolean; tab: BrowserTab }>({ open: false, tab: 'files' });
  const browserOpen = browserState.projectId === project?.id && browserState.open;
  const [browserWidth, setBrowserWidth] = useState(() => readRailWidth('asterium.studio.browserWidth', 300, 240, 480));
  if (browserState.projectId !== project?.id) setBrowserState({ projectId: project?.id, open: false, tab: 'files' });
  useEffect(() => { localStorage.setItem('asterium.studio.browserWidth', String(browserWidth)); }, [browserWidth]);
  const studioRoom = groupChat ? studioRooms[groupChat.id] : undefined;
  const [projectFilesRefresh, refreshProjectFiles] = useProjectBrowseRefresh(project?.id, projectFilesOpen && project?.workspace?.status === 'ready');
  const activeHandoff = contextHandoffDraft?.target.kind === 'group' && contextHandoffDraft.target.id === groupChat?.id ? contextHandoffDraft : undefined;
  const handoffTargets = state.conversations.flatMap(conversation => {
    const partner = state.partners.find(item => item.id === conversation.partnerId);
    if (!partner || !supportsContextHandoff(partner) || conversation.isArchived || conversation.isDisabled || !groupChat?.memberIds.includes(partner.id)) return [];
    return [{ kind: 'single' as const, id: conversation.id, partnerId: partner.id, label: `${partner.publicIdentity.displayName} · ${conversation.title}` }];
  });
  const activeRound = studioRoom?.activeRound && !['completed', 'failed', 'cancelled'].includes(studioRoom.activeRound.state) ? studioRoom.activeRound : undefined;
  const projectPermissionMode = project && projectExecutionPolicy?.projectId === project.id ? projectExecutionPolicy.permissionMode : 'manual';
  const ProjectPermissionIcon = projectPermissionOption(projectPermissionMode).icon;
  const currentSpeaker = members.find((partner) => partner.id === activeRound?.currentPartnerId);
  const studioInteraction = groupChat ? studioInteractions[groupChat.id] : undefined;
  const studioInteractionPartner = members.find((partner) => partner.id === studioInteraction?.partnerId) ?? currentSpeaker;
  const studioInteractionMessageId = studioInteraction
    ? [...(groupChat?.messages ?? [])].reverse().find((message) => (
      message.authorId === studioInteraction.partnerId && message.runId === studioInteraction.runId
    ))?.id
    : undefined;
  const activeWorkflowGeneration = workflowGenerations.find((item) => item.id === activeWorkflowGenerationId);
  const workflowGenerationMessages = (groupChat?.messages ?? []).filter((message) => Boolean(message.studioSeq));
  const workflowGenerationSelectedCharacters = workflowGenerationMessages
    .filter((message) => workflowGenerationMessageIds.includes(message.id))
    .reduce((total, message) => total + message.content.length, 0);
  const mentionOptions: StudioMentionOption[] = members.map((partner) => {
    const muted = Boolean(studioRoom?.mutedPartnerIds.includes(partner.id));
    const unsupported = partner.isRemoved || partner.isPrototype
      || (partner.sourceMode !== 'existing_thread' && (partner.sourceMode === 'api_partner' ? !partner.configured : partner.connectionKind !== 'local_claude' && partner.connectionKind !== 'local_codex'));
    return {
      partnerId: partner.id,
      displayName: partner.publicIdentity.displayName,
      mentionName: partner.publicIdentity.mentionName?.trim() || partner.publicIdentity.displayName,
      expertise: partner.publicIdentity.expertise,
      avatarDataUrl: partner.publicIdentity.avatarDataUrl,
      accent: partner.accent,
      disabled: muted || unsupported,
      disabledReason: muted ? '已禁言' : unsupported ? '当前不能参与真实群聊' : undefined,
    };
  });
  const messageReferences = (groupChat?.messages ?? []).flatMap((message) => {
    if (!message.studioSeq) return [];
    const author = isAsteriumUser(message.authorId)
      ? userProfile.displayName
      : state.partners.find((partner) => partner.id === message.authorId)?.publicIdentity.displayName;
    return author ? [{ seq: message.studioSeq, messageId: message.id, authorName: author, excerpt: message.content.replace(/\s+/g, ' ').slice(0, 120) }] : [];
  });
  const renderStudioInteractionTimeline = () => studioInteraction ? <TurnTimeline
    message={{ id: `studio-interaction:${studioInteraction.runId}`, authorId: studioInteraction.partnerId, content: '', createdAt: '', timeline: studioInteraction.timeline }}
    partnerName={studioInteractionPartner?.publicIdentity.displayName ?? '伙伴'}
    pendingAuthorization={studioInteraction.pendingAuthorization}
    pendingUserInput={studioInteraction.pendingUserInput}
    onResolveAuthorization={(decision, persist) => groupChat && resolveStudioAuthorization(groupChat.id, decision, persist)}
    onResolveUserInput={(answers, custom, requestId) => { if (!groupChat) throw new Error('USER_INPUT_NOT_PENDING'); return resolveStudioUserInput(groupChat.id, answers, custom, requestId); }}
    onOpenArtifact={() => undefined}
  /> : null;

  useEffect(() => {
    if (isWork || !keepAtBottomRef.current) return;
    const frame = requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (list && keepAtBottomRef.current) list.scrollTop = list.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [groupChat?.messages, studioInteraction?.timeline, isWork]);

  useEffect(() => {
    keepAtBottomRef.current = true;
    const frame = requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (list && keepAtBottomRef.current) list.scrollTop = list.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [groupChat?.id]);

  useEffect(() => {
    window.localStorage.setItem('asterium.studio.leftRailWidth', String(leftRailWidth));
  }, [leftRailWidth]);

  useEffect(() => {
    window.localStorage.setItem('asterium.studio.rightRailWidth', String(rightRailWidth));
  }, [rightRailWidth]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setNotes([]);
      setNoteDraft('');
      setEditingNoteId(undefined);
      setNoteArchiveOpen(false);
      setNoteDeleteTarget(undefined);
    });
    if (!project?.id || !window.asteriumStudioNotes) return;
    void window.asteriumStudioNotes.list(project.id).then((items) => {
      if (!cancelled) setNotes(items);
    }).catch(() => {
      if (!cancelled) setNotes([]);
    });
    return () => { cancelled = true; };
  }, [project?.id]);

  useEffect(() => {
    if (!project?.id || !window.asteriumProjects?.listWorkflowGenerations) {
      void Promise.resolve().then(() => setWorkflowGenerations([]));
      return;
    }
    const projectId = project.id;
    let cancelled = false;
    void window.asteriumProjects.listWorkflowGenerations(projectId).then((items) => {
      if (!cancelled) setWorkflowGenerations((current) => mergeWorkflowGenerations(current.filter((item) => item.projectId === projectId), items));
    }).catch(() => {
      if (!cancelled) setWorkflowGenerationError('工作流生成记录读取失败。');
    });
    const dispose = window.asteriumProjects.onWorkflowGenerationChanged?.((change) => {
      if (change.type === 'project_removed') {
        if (change.projectId === projectId) setWorkflowGenerations([]);
        return;
      }
      if (change.generation.projectId !== projectId) return;
      setWorkflowGenerations((current) => mergeWorkflowGenerations(current, [change.generation]));
      if (change.generation.id !== activeWorkflowGenerationId) return;
      if (change.generation.status === 'submitted' && change.generation.workflowId) {
        void window.asteriumProjects?.listWorkflows(projectId).then((items) => {
          if (cancelled) return;
          setWorkflows(items);
          const workflow = items.find((item) => item.id === change.generation.workflowId);
          if (workflow) {
            setShowWorkflowGeneration(false);
            setEditingWorkflow(workflow);
            setWorkflowError('');
          }
        });
      }
    });
    return () => { cancelled = true; dispose?.(); };
  }, [project?.id, activeWorkflowGenerationId]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (!project?.id || !window.asteriumProjects?.workflowCatalog) return;
      void Promise.all([
        window.asteriumProjects.workflowCatalog(project.id),
        window.asteriumProjects.listWorkflows(project.id),
      ]).then(([catalog, items]) => {
        if (!cancelled) {
          setWorkflowCatalog(catalog);
          setWorkflows(items);
          setWorkflowError('');
        }
      }).catch(() => {
        if (!cancelled) setWorkflowError('流程草稿读取失败');
      });
    };
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setWorkflowCatalog(undefined);
        setWorkflows([]);
        setShowWorkflowManager(false);
        setShowWorkflowTemplates(false);
        setEditingWorkflow(undefined);
        setWorkflowActivationId('');
        setWorkflowError('');
        setWorkflowTemplateDialog(undefined);
        setWorkflowTemplateDeleteTarget(undefined);
      }
    });
    load();
    const unsubscribe = window.asteriumProjects?.onWorkflowsChanged?.((change) => {
      if (change.projectId === project?.id) load();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [project?.id]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (!project?.id || !window.asteriumProjects?.listRoles) return;
      void window.asteriumProjects.listRoles(project.id).then((catalog) => {
        if (!cancelled) {
          setRoleCatalog(catalog);
          setRoleCatalogError('');
        }
      }).catch(() => {
        if (!cancelled) setRoleCatalogError('工作角色读取失败');
      });
    };
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setRoleCatalog(undefined);
        setRoleCatalogError('');
        setShowRoleManager(false);
        setEditingRole(undefined);
      }
    });
    load();
    const unsubscribe = window.asteriumProjects?.onRolesChanged?.((change) => {
      if (change.scope === 'global' || change.projectId === project?.id) load();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [project?.id]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setTaskExecutions({ version: 1, attempts: [], events: [] });
        setTaskExecutionError('');
      }
    });
    if (!project?.id || !window.asteriumProjects?.getTaskExecution) return;
    void window.asteriumProjects.getTaskExecution(project.id).then((snapshot) => {
      if (!cancelled) setTaskExecutions(snapshot);
    }).catch(() => {
      if (!cancelled) setTaskExecutionError('任务执行状态读取失败');
    });
    const unsubscribe = window.asteriumProjects.onTaskExecutionChanged?.((change) => {
      if (cancelled || change.type !== 'snapshot') return;
      setTaskExecutions({
        version: 1,
        attempts: change.snapshot.attempts.filter((attempt) => attempt.projectId === project.id),
        events: change.snapshot.events.filter((event) => event.projectId === project.id),
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [project?.id]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setProjectExecutionPolicy(undefined);
        setProjectPermissionError('');
      }
    });
    if (!project?.id || !window.asteriumProjects?.getExecutionPolicy) return;
    void window.asteriumProjects.getExecutionPolicy(project.id).then((policy) => {
      if (!cancelled) setProjectExecutionPolicy(policy);
    }).catch(() => {
      if (!cancelled) setProjectPermissionError('项目权限读取失败');
    });
    const unsubscribe = window.asteriumProjects.onExecutionPolicyChanged?.((policy) => {
      if (!cancelled && policy.projectId === project.id) setProjectExecutionPolicy(policy);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [project?.id]);

  useEffect(() => {
    if (!memberMenu && !projectFileMenu && !openHeaderMenu) return;
    const close = () => {
      setMemberMenu(undefined);
      setProjectFileMenu(undefined);
      setOpenHeaderMenu(undefined);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [memberMenu, projectFileMenu, openHeaderMenu]);

  const beginProjectFileDeletion = async (fileId: string) => {
    if (!project || !window.asteriumProjects?.inspectFileDeletion || !window.asteriumProjects.deleteFile) return;
    setProjectFileMenu(undefined);
    setFileDeletionBusy(true);
    setFileDeletionError('');
    try {
      const inspection = await window.asteriumProjects.inspectFileDeletion(project.id, fileId);
      setFileDeletionInspection(inspection);
      if (!inspection.requiresConfirmation && inspection.canDelete) {
        await window.asteriumProjects.deleteFile(project.id, fileId);
        setFileDeletionInspection(undefined);
      }
    } catch (error) {
      setFileDeletionError(friendlyRuntimeErrorMessage(fileDeletionErrorMessage(error)));
    } finally {
      setFileDeletionBusy(false);
    }
  };

  const confirmProjectFileDeletion = async () => {
    if (!project || fileDeletionInspection?.target.kind !== 'project_file' || !window.asteriumProjects?.inspectFileDeletion || !window.asteriumProjects.deleteFile) return;
    setFileDeletionBusy(true);
    setFileDeletionError('');
    try {
      await window.asteriumProjects.deleteFile(project.id, fileDeletionInspection.target.fileId);
      setFileDeletionInspection(undefined);
    } catch (error) {
      try {
        setFileDeletionInspection(await window.asteriumProjects.inspectFileDeletion(project.id, fileDeletionInspection.target.fileId));
      } catch { /* retain the last safe inspection */ }
      setFileDeletionError(friendlyRuntimeErrorMessage(fileDeletionErrorMessage(error)));
    } finally {
      setFileDeletionBusy(false);
    }
  };

  const filteredTasks = (project?.tasks ?? []).filter((task) => {
    return filter === 'all' || task.status === filter;
  });

  const controlTaskExecution = async (task: TaskItem, action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry', attempt?: TaskAttempt, reason?: string) => {
    if (!project || !window.asteriumProjects) return;
    setTaskExecutionBusy(task.id);
    setTaskExecutionError('');
    try {
      if (action === 'start') await window.asteriumProjects.enqueueTaskAttempt({ projectId: project.id, taskId: task.id });
      else if (!attempt) throw new Error('TASK_ATTEMPT_REQUIRED');
      else if (action === 'pause') await window.asteriumProjects.pauseTaskAttempt({ attemptId: attempt.id, reason: '用户从工作室任务页暂停。' });
      else if (action === 'resume') await window.asteriumProjects.resumeTaskAttempt({ attemptId: attempt.id, reason: reason?.trim() || '用户从工作室任务页恢复。' });
      else if (action === 'cancel') await window.asteriumProjects.cancelTaskAttempt({ attemptId: attempt.id, reason: '用户从工作室任务页取消。' });
      else await window.asteriumProjects.retryTaskAttempt({ attemptId: attempt.id });
    } catch (error) {
      setTaskExecutionError(taskExecutionMessage(error));
    } finally {
      setTaskExecutionBusy(undefined);
    }
  };

  const resolveTaskGate = async (task: TaskItem, action: 'accept' | 'request_changes', feedback?: string, affectedCriteria?: string[]) => {
    if (!project || !window.asteriumProjects) return;
    setTaskExecutionBusy(task.id);
    setTaskExecutionError('');
    try {
      await window.asteriumProjects.resolveTaskGate({
        projectId: project.id, taskId: task.id, action,
        ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
        ...(affectedCriteria?.length ? { affectedCriteria } : {}),
      });
    } catch (error) {
      setTaskExecutionError(taskExecutionMessage(error));
    } finally {
      setTaskExecutionBusy(undefined);
    }
  };

  const openProjectConversation = () => {
    setSelectedProjectId(state.activeProjectId || state.projects[0]?.id || '');
    setProjectChoice('new');
    setNewProjectName('');
    setNewProjectDescription('');
    setProjectLocation(null);
    setNewGroupName('');
    setProjectError('');
    setShowNewConversation(true);
  };

  const openGroupForProject = async (projectId: string) => {
    setProjectError('');
    const targetProject = state.projects.find((item) => item.id === projectId);
    if (!targetProject) return setProjectError('没有找到这个项目。');
    const existingNames = state.groupChats
      .filter((item) => item.projectId === projectId && !item.archivedAt)
      .map((item) => item.name);
    try {
      await createGroupChat(projectId, nextGroupChatName(existingNames), targetProject.memberIds);
      setExpandedProjects((current) => new Set(current).add(projectId));
      navigate('/studio/discussion');
    } catch (error) {
      setProjectError(projectWorkspaceError(error));
    }
  };

  const submitProjectConversation = async () => {
    setProjectError('');
    if (!newGroupName.trim()) return setProjectError('请填写群聊名称。');
    setProjectBusy(true);
    try {
      if (projectChoice === 'existing') {
        if (!selectedProjectId) return setProjectError('请选择一个项目。');
        await createGroupChat(selectedProjectId, newGroupName, state.projects.find((item) => item.id === selectedProjectId)?.memberIds);
      } else {
        if (!newProjectName.trim()) return setProjectError('请填写新项目名称。');
        const projectId = await createProject(newProjectName, {
          description: newProjectDescription,
          ...(projectLocation?.selectionId ? { locationSelectionId: projectLocation.selectionId } : {}),
        });
        await createGroupChat(projectId, newGroupName, []);
      }
      setShowNewConversation(false);
      navigate('/studio/discussion');
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('PROJECT_CREATE_CANCELLED'))) setProjectError(projectWorkspaceError(error));
    } finally {
      setProjectBusy(false);
    }
  };

  const chooseProjectLocation = async () => {
    setProjectError('');
    try {
      const selection = await window.asteriumProjects?.chooseLocation();
      if (selection) setProjectLocation(selection);
    } catch (error) {
      setProjectError(projectWorkspaceError(error));
    }
  };

  const initializeWorkspace = async () => {
    if (!project) return;
    setProjectError('');
    setWorkspaceBusy(true);
    try {
      await initializeProjectWorkspace(project.id);
    } catch (error) {
      setProjectError(projectWorkspaceError(error));
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const beginGroupEdit = (target = groupChat) => {
    if (!target) return;
    setEditingGroup(target);
    setDraftName(target.name);
  };

  const closeGroupEdit = () => {
    setEditingGroup(undefined);
    setDraftName('');
  };

  const saveGroup = () => {
    if (!editingGroup || !draftName.trim()) return;
    updateGroupChat({ ...editingGroup, name: draftName.trim(), updatedAt: new Date().toISOString() });
    closeGroupEdit();
  };

  const beginMemberManagement = () => {
    if (!groupChat) return;
    setDraftMembers([...groupChat.memberIds]);
    setShowMembers(true);
  };

  const saveMembers = async () => {
    if (!groupChat) return;
    setShowMembers(false);
    try {
      await setGroupMembers(groupChat.id, draftMembers);
    } catch {
      setStudioSendError('成员变更没有完成，请稍后重试。');
    }
  };

  const beginProjectEdit = () => {
    if (!project) return;
    setProjectError('');
    setEditingProject(project);
    setProjectDraftName(project.name);
    setProjectDraftDescription(project.description);
    setProjectDraftStatus(project.status);
    setProjectDraftProgress(project.progress);
    setProjectDraftTags(project.tags.join('、'));
    setProjectDraftAvatar(project.avatarDataUrl);
    setProjectDraftMembers([...project.memberIds]);
    if (projectAvatarInput.current) projectAvatarInput.current.value = '';
  };

  const closeProjectEdit = () => {
    setEditingProject(undefined);
    setProjectDraftName('');
    setProjectDraftDescription('');
    setProjectDraftStatus('active');
    setProjectDraftProgress(0);
    setProjectDraftTags('');
    setProjectDraftAvatar(undefined);
    setProjectDraftMembers([]);
    if (projectAvatarInput.current) projectAvatarInput.current.value = '';
  };

  const saveProject = async () => {
    if (!editingProject || !projectDraftName.trim()) return;
    setProjectBusy(true);
    setProjectError('');
    try {
      const memberUpdatedProject = await setProjectMembers(editingProject.id, projectDraftMembers) ?? editingProject;
      await updateProject({
        ...memberUpdatedProject,
        name: projectDraftName.trim(),
        description: projectDraftDescription.trim() || '这个项目还没有填写简介。',
        avatarDataUrl: projectDraftAvatar,
        memberIds: [...projectDraftMembers],
        status: projectDraftStatus,
        progress: projectDraftProgress,
        tags: projectDraftTags.split(/[，,、]/).map((item) => item.trim()).filter(Boolean),
      });
      closeProjectEdit();
    } catch (error) {
      setProjectError(error instanceof Error && error.message === 'STUDIO_PROJECT_HAS_ACTIVE_ROUND'
        ? '项目中仍有伙伴正在发言，请结束本轮后再移出项目成员。'
        : error instanceof Error && error.message.includes('PROJECT_REVISION_CONFLICT')
          ? '项目已在其他窗口更新，请关闭后重新打开。'
          : '项目资料没有保存成功，请稍后重试。');
    } finally {
      setProjectBusy(false);
    }
  };

  const deleteProject = async () => {
    if (!projectDeleteTarget) return;
    setProjectBusy(true);
    setProjectError('');
    try {
      await removeProject(projectDeleteTarget.id);
      setExpandedProjects((current) => {
        const next = new Set(current);
        next.delete(projectDeleteTarget.id);
        return next;
      });
      setProjectDeleteTarget(undefined);
      closeProjectEdit();
    } catch (error) {
      setProjectError(error instanceof Error && error.message === 'STUDIO_PROJECT_HAS_ACTIVE_ROUND'
        ? '项目中仍有伙伴正在发言，请先停止当前轮次再删除项目。'
        : '项目没有删除成功，请稍后重试。');
    } finally {
      setProjectBusy(false);
    }
  };

  const saveNote = async () => {
    if (!project || !noteDraft.trim() || !window.asteriumStudioNotes) return;
    const saved = await window.asteriumStudioNotes.save({ id: editingNoteId, projectId: project.id, content: noteDraft });
    setNotes((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    setNoteDraft('');
    setEditingNoteId(undefined);
  };

  const updateNoteStatus = async (note: StudioNote, status: StudioNote['status']) => {
    const updated = await window.asteriumStudioNotes?.setStatus(note.id, status);
    if (updated) setNotes((current) => current.map((item) => item.id === updated.id ? updated : item));
  };

  const openProjectNotebook = async (partner: Partner) => {
    if (!project || !window.asteriumProjectNotebooks) return;
    setNotebookTarget(partner);
    setProjectNotebook(undefined);
    setProjectNotebookDraft('');
    setProjectNotebookError('');
    setProjectNotebookBusy(true);
    try {
      const notebook = await window.asteriumProjectNotebooks.get({ partnerId: partner.id, projectId: project.id });
      setProjectNotebook(notebook);
      setProjectNotebookDraft(notebook?.content ?? '');
    } catch {
      setProjectNotebookError('项目工作笔记本没有读取成功。');
    } finally {
      setProjectNotebookBusy(false);
    }
  };

  const saveProjectNotebook = async () => {
    if (!project || !notebookTarget || !window.asteriumProjectNotebooks) return;
    setProjectNotebookBusy(true);
    setProjectNotebookError('');
    try {
      const saved = await window.asteriumProjectNotebooks.replace({
        partnerId: notebookTarget.id,
        projectId: project.id,
        content: projectNotebookDraft,
        expectedRevision: projectNotebook?.revision ?? 0,
      });
      setProjectNotebook(saved);
      setProjectNotebookDraft(saved.content);
    } catch (error) {
      setProjectNotebookError(error instanceof Error && error.message.includes('PROJECT_NOTEBOOK_REVISION_CONFLICT')
        ? '笔记已被伙伴或其他窗口更新，请关闭后重新打开，避免覆盖新内容。'
        : '项目工作笔记本没有保存成功。');
    } finally {
      setProjectNotebookBusy(false);
    }
  };

  const submitStudioMessage = async (content: string, mentions: StudioMention[], attachments: PendingMessageAttachment[] = []) => {
    if (!groupChat) return;
    setStudioSendError('');
    const ok = await sendStudioMessage(groupChat.id, content, mentions, attachments.map(item => item.selectionId), activeHandoff).catch(error => {
      if (error instanceof Error && error.message.includes('HANDOFF_')) {
        setStudioSendError(error.message.includes('HANDOFF_SOURCE_UNAVAILABLE') || error.message.includes('HANDOFF_TEXT_TOO_LONG')
          ? '选中的原话已变化或超出长度限制，请重新选择。'
          : '未能发送交接。请确认目标伙伴仍在群里，并将其加入本轮发言名单。');
        return undefined;
      }
      throw error;
    });
    if (ok === undefined) return false;
    if (!ok) setStudioSendError(activeRound ? '请等这一轮结束，或先停止当前伙伴。' : '没有可发言的伙伴；请检查成员、禁言和连接状态。');
    return ok;
  };

  const updateStudioSettings = (patch: Partial<StudioRoomSettings>) => {
    if (!groupChat || !studioRoom || activeRound) return;
    void setStudioSettings(groupChat.id, { ...studioRoom.settings, ...patch });
  };

  const updateProjectPermission = async (permissionMode: ProjectPermissionMode) => {
    setOpenHeaderMenu(undefined);
    if (!project || !window.asteriumProjects?.setExecutionPolicy || projectPermissionBusy) return;
    setProjectPermissionBusy(true);
    setProjectPermissionError('');
    try {
      setProjectExecutionPolicy(await window.asteriumProjects.setExecutionPolicy({ projectId: project.id, permissionMode }));
    } catch {
      setProjectPermissionError('项目权限没有保存成功');
    } finally {
      setProjectPermissionBusy(false);
    }
  };

  const refreshRoleCatalog = async () => {
    if (!project || !window.asteriumProjects?.listRoles) return;
    setRoleCatalog(await window.asteriumProjects.listRoles(project.id));
  };

  const beginRoleCreate = () => {
    setEditingRole('new');
    setRoleDraft(EMPTY_WORK_ROLE_DRAFT);
    setRoleError('');
  };

  const beginRoleEdit = (role: ProjectWorkRoleDefinition) => {
    if (role.scope === 'builtin') return;
    setEditingRole(role);
    setRoleDraft({
      scope: role.scope,
      group: role.group,
      name: role.name,
      description: role.description,
      responsibilities: role.responsibilities.join('\n'),
      prompt: role.prompt,
    });
    setRoleError('');
  };

  const saveRole = async () => {
    if (!project || !editingRole || !window.asteriumProjects || !roleDraft.name.trim()) return;
    const responsibilities = roleDraft.responsibilities.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!responsibilities.length) {
      setRoleError('请至少填写一项角色职责。');
      return;
    }
    setRoleBusy(true);
    setRoleError('');
    try {
      if (editingRole === 'new') {
        await window.asteriumProjects.createRole({
          scope: roleDraft.scope,
          ...(roleDraft.scope === 'project' ? { projectId: project.id } : {}),
          group: roleDraft.group.trim(),
          name: roleDraft.name.trim(),
          description: roleDraft.description.trim(),
          responsibilities,
          prompt: roleDraft.prompt.trim(),
        });
      } else {
        await window.asteriumProjects.updateRole({
          roleId: editingRole.id,
          expectedRevision: editingRole.revision,
          group: roleDraft.group.trim(),
          name: roleDraft.name.trim(),
          description: roleDraft.description.trim(),
          responsibilities,
          prompt: roleDraft.prompt.trim(),
        });
      }
      await refreshRoleCatalog();
      setEditingRole(undefined);
    } catch (error) {
      setRoleError(projectRoleError(error));
    } finally {
      setRoleBusy(false);
    }
  };

  const toggleRoleArchived = async (role: ProjectWorkRoleDefinition) => {
    if (!window.asteriumProjects || role.scope === 'builtin') return;
    setRoleBusy(true);
    setRoleError('');
    try {
      await window.asteriumProjects.archiveRole({ roleId: role.id, expectedRevision: role.revision, archived: !role.archivedAt });
      await refreshRoleCatalog();
    } catch (error) {
      setRoleError(projectRoleError(error));
    } finally {
      setRoleBusy(false);
    }
  };

  const deleteRole = async () => {
    if (!roleDeleteTarget || !window.asteriumProjects || roleDeleteTarget.scope === 'builtin') return;
    setRoleBusy(true);
    setRoleError('');
    try {
      await window.asteriumProjects.removeRole({ roleId: roleDeleteTarget.id, expectedRevision: roleDeleteTarget.revision });
      await refreshRoleCatalog();
      setRoleDeleteTarget(undefined);
      if (editingRole !== 'new' && editingRole?.id === roleDeleteTarget.id) setEditingRole(undefined);
    } catch (error) {
      setRoleError(projectRoleError(error));
    } finally {
      setRoleBusy(false);
    }
  };

  const refreshWorkflows = async () => {
    if (!project || !window.asteriumProjects?.listWorkflows) return [];
    const items = await window.asteriumProjects.listWorkflows(project.id);
    setWorkflows(items);
    return items;
  };

  const refreshWorkflowCatalog = async () => {
    if (!project || !window.asteriumProjects?.workflowCatalog) return undefined;
    const catalog = await window.asteriumProjects.workflowCatalog(project.id);
    setWorkflowCatalog(catalog);
    return catalog;
  };

  const openWorkflowGeneration = () => {
    if (!project || !groupChat || activeRound) return;
    const current = [...workflowGenerations]
      .filter((generation) => generation.roomId === groupChat.id && ['running', 'failed', 'cancelled', 'interrupted'].includes(generation.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (current) {
      setWorkflowGenerationPlannerId(current.plannerPartnerId);
      setWorkflowGenerationMessageIds(current.sourceMessages.map((message) => message.messageId));
      setActiveWorkflowGenerationId(current.id);
      setWorkflowGenerationError('');
      setShowWorkflowGeneration(true);
      return;
    }
    const selectable = groupChat.messages.filter((message) => Boolean(message.studioSeq));
    const defaultMessages = selectable.slice(-20).map((message) => message.id);
    const defaultPlanner = mentionOptions.find((option) => !option.disabled)?.partnerId ?? '';
    setWorkflowGenerationPlannerId(defaultPlanner);
    setWorkflowGenerationMessageIds(defaultMessages);
    setActiveWorkflowGenerationId(undefined);
    setWorkflowGenerationError('');
    setShowWorkflowGeneration(true);
  };

  const startWorkflowGeneration = async () => {
    const api = window.asteriumProjects?.startWorkflowGeneration;
    if (!api || !project || !groupChat || !workflowGenerationPlannerId || !workflowGenerationMessageIds.length || workflowGenerationBusy || activeRound) return;
    setWorkflowGenerationBusy(true);
    setWorkflowGenerationError('');
    try {
      const generation = await api({
        requestId: crypto.randomUUID(),
        projectId: project.id,
        roomId: groupChat.id,
        plannerPartnerId: workflowGenerationPlannerId,
        messageIds: workflowGenerationMessageIds,
      });
      setWorkflowGenerations((current) => mergeWorkflowGenerations(current, [generation]));
      setActiveWorkflowGenerationId(generation.id);
      if (generation.status === 'submitted' && generation.workflowId) {
        const items = await refreshWorkflows();
        const workflow = items?.find((item) => item.id === generation.workflowId);
        if (workflow) { setShowWorkflowGeneration(false); setEditingWorkflow(workflow); }
      }
    } catch (error) {
      setWorkflowGenerationError(workflowGenerationErrorMessage(error));
    } finally {
      setWorkflowGenerationBusy(false);
    }
  };

  const cancelWorkflowGeneration = async () => {
    const api = window.asteriumProjects?.cancelWorkflowGeneration;
    if (!api || !project || !activeWorkflowGeneration || workflowGenerationBusy) return;
    setWorkflowGenerationBusy(true);
    try {
      const generation = await api({ projectId: project.id, generationId: activeWorkflowGeneration.id });
      setWorkflowGenerations((current) => mergeWorkflowGenerations(current, [generation]));
    } catch (error) {
      setWorkflowGenerationError(workflowGenerationErrorMessage(error));
    } finally {
      setWorkflowGenerationBusy(false);
    }
  };

  const retryWorkflowGeneration = async () => {
    const api = window.asteriumProjects?.retryWorkflowGeneration;
    if (!api || !project || !activeWorkflowGeneration || workflowGenerationBusy) return;
    setWorkflowGenerationBusy(true);
    setWorkflowGenerationError('');
    try {
      const generation = await api({ projectId: project.id, generationId: activeWorkflowGeneration.id, requestId: crypto.randomUUID() });
      setWorkflowGenerations((current) => mergeWorkflowGenerations(current, [generation]));
      setActiveWorkflowGenerationId(generation.id);
    } catch (error) {
      setWorkflowGenerationError(workflowGenerationErrorMessage(error));
    } finally {
      setWorkflowGenerationBusy(false);
    }
  };

  const closeWorkflowWindows = () => {
    if (workflowBusy) return;
    setShowWorkflowManager(false);
    setShowWorkflowTemplates(false);
    setEditingWorkflow(undefined);
    setWorkflowActivationId('');
    setWorkflowTemplateDialog(undefined);
    setWorkflowTemplateDeleteTarget(undefined);
    setWorkflowDeleteTarget(undefined);
    setWorkflowError('');
  };

  const createWorkflowFromTemplate = async (templateId: string) => {
    if (!project || !window.asteriumProjects?.createWorkflow) return;
    setWorkflowBusy(true);
    setWorkflowError('');
    try {
      const created = await window.asteriumProjects.createWorkflow({ projectId: project.id, templateId });
      setEditingWorkflow(structuredClone(created));
      setWorkflowActivationId(crypto.randomUUID());
      await refreshWorkflows();
    } catch (error) {
      setWorkflowError(projectWorkflowError(error));
    } finally {
      setWorkflowBusy(false);
    }
  };

  const persistWorkflow = async () => {
    if (!project || !editingWorkflow || !window.asteriumProjects?.updateWorkflow) throw new Error('PROJECT_WORKFLOW_NOT_READY');
    const updated = await window.asteriumProjects.updateWorkflow({
      projectId: project.id,
      workflowId: editingWorkflow.id,
      expectedRevision: editingWorkflow.revision,
      name: editingWorkflow.name,
      description: editingWorkflow.description,
      nodes: editingWorkflow.nodes.map((node, position) => ({ ...node, position })),
    });
    setEditingWorkflow(structuredClone(updated));
    await refreshWorkflows();
    return updated;
  };

  const saveWorkflow = async () => {
    if (!editingWorkflow?.name.trim()) return;
    setWorkflowBusy(true);
    setWorkflowError('');
    try {
      await persistWorkflow();
    } catch (error) {
      setWorkflowError(projectWorkflowError(error));
    } finally {
      setWorkflowBusy(false);
    }
  };

  const activateWorkflow = async () => {
    if (!project || !editingWorkflow || !window.asteriumProjects?.activateWorkflow) return;
    setWorkflowBusy(true);
    setWorkflowError('');
    const activationId = workflowActivationId || crypto.randomUUID();
    if (!workflowActivationId) setWorkflowActivationId(activationId);
    try {
      const saved = await persistWorkflow();
      await window.asteriumProjects.activateWorkflow({
        projectId: project.id,
        workflowId: saved.id,
        expectedRevision: saved.revision,
        activationId,
      });
      await refreshWorkflows();
      setEditingWorkflow(undefined);
      setWorkflowActivationId('');
      setShowWorkflowTemplates(false);
      setShowWorkflowManager(false);
    } catch (error) {
      const latest = await refreshWorkflows().catch(() => []);
      if (latest.some((workflow) => workflow.id === editingWorkflow.id && workflow.activationId === activationId && (workflow.status === 'active' || workflow.status === 'completed'))) {
        setEditingWorkflow(undefined);
        setWorkflowActivationId('');
        setShowWorkflowTemplates(false);
        setShowWorkflowManager(false);
      } else setWorkflowError(projectWorkflowError(error));
    } finally {
      setWorkflowBusy(false);
    }
  };

  const deleteWorkflow = async () => {
    if (!project || !workflowDeleteTarget || !window.asteriumProjects?.removeWorkflow) return;
    setWorkflowBusy(true);
    setWorkflowError('');
    try {
      await window.asteriumProjects.removeWorkflow({
        projectId: project.id,
        workflowId: workflowDeleteTarget.id,
        expectedRevision: workflowDeleteTarget.revision,
      });
      setWorkflowDeleteTarget(undefined);
      await refreshWorkflows();
    } catch (error) {
      setWorkflowError(projectWorkflowError(error));
    } finally {
      setWorkflowBusy(false);
    }
  };

  const openWorkflowTemplateDialog = (mode: 'new' | 'update') => {
    if (!editingWorkflow) return;
    const source = mode === 'update'
      ? workflowCatalog?.templates.find((template) => template.kind === 'project' && template.id === editingWorkflow.sourceTemplate?.templateId)
      : undefined;
    if (mode === 'update' && !source) return;
    setWorkflowTemplateName(source?.name ?? editingWorkflow.name);
    setWorkflowTemplateDescription(source?.description ?? editingWorkflow.description);
    setWorkflowTemplateDialog(mode);
    setWorkflowError('');
  };

  const saveWorkflowTemplate = async () => {
    if (!project || !editingWorkflow || !workflowTemplateDialog || !workflowTemplateName.trim()) return;
    const api = window.asteriumProjects;
    if (!api?.saveWorkflowTemplate || !api.updateWorkflowTemplate) return;
    setWorkflowBusy(true);
    setWorkflowError('');
    try {
      const workflow = await persistWorkflow();
      if (workflowTemplateDialog === 'new') {
        await api.saveWorkflowTemplate({
          projectId: project.id,
          workflowId: workflow.id,
          expectedWorkflowRevision: workflow.revision,
          name: workflowTemplateName,
          description: workflowTemplateDescription,
        });
      } else {
        const source = workflowCatalog?.templates.find((template) => template.kind === 'project' && template.id === workflow.sourceTemplate?.templateId);
        if (!source?.revision) throw new Error('PROJECT_WORKFLOW_TEMPLATE_NOT_FOUND');
        await api.updateWorkflowTemplate({
          projectId: project.id,
          templateId: source.id,
          expectedTemplateRevision: source.revision,
          workflowId: workflow.id,
          expectedWorkflowRevision: workflow.revision,
          name: workflowTemplateName,
          description: workflowTemplateDescription,
        });
      }
      await refreshWorkflowCatalog();
      setWorkflowTemplateDialog(undefined);
    } catch (error) {
      setWorkflowError(projectWorkflowError(error));
    } finally {
      setWorkflowBusy(false);
    }
  };

  const deleteWorkflowTemplate = async () => {
    if (!project || !workflowTemplateDeleteTarget?.revision || !window.asteriumProjects?.removeWorkflowTemplate) return;
    setWorkflowBusy(true);
    setWorkflowError('');
    try {
      await window.asteriumProjects.removeWorkflowTemplate({
        projectId: project.id,
        templateId: workflowTemplateDeleteTarget.id,
        expectedRevision: workflowTemplateDeleteTarget.revision,
      });
      setWorkflowTemplateDeleteTarget(undefined);
      await refreshWorkflowCatalog();
    } catch (error) {
      setWorkflowError(projectWorkflowError(error));
    } finally {
      setWorkflowBusy(false);
    }
  };

  const updateWorkflowNode = (nodeId: string, update: (node: ProjectWorkflowDraftNode) => ProjectWorkflowDraftNode) => {
    setEditingWorkflow((current) => current ? { ...current, nodes: current.nodes.map((node) => node.id === nodeId ? update(node) : node) } : current);
  };

  const addWorkflowNode = () => {
    const role = roleCatalog?.roles.find((item) => item.id === 'builtin-general-executor' && !item.archivedAt);
    setEditingWorkflow((current) => current ? {
      ...current,
      nodes: [...current.nodes, {
        id: crypto.randomUUID(), position: current.nodes.length, title: '新步骤', description: '',
        dependencyNodeIds: [], acceptanceCriteria: [], note: '',
        execution: {
          ...(role ? { workRole: projectWorkRoleSnapshot(role) } : {}),
          completionRule: { type: 'executor_submit' },
        },
      }],
    } : current);
  };

  const removeWorkflowNode = (nodeId: string) => {
    setEditingWorkflow((current) => current ? {
      ...current,
      nodes: current.nodes.filter((node) => node.id !== nodeId).map((node, position) => ({
        ...node, position, dependencyNodeIds: node.dependencyNodeIds.filter((id) => id !== nodeId),
      })),
    } : current);
  };

  const moveWorkflowNode = (nodeId: string, offset: -1 | 1) => {
    setEditingWorkflow((current) => {
      if (!current) return current;
      const index = current.nodes.findIndex((node) => node.id === nodeId);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.nodes.length) return current;
      const nodes = [...current.nodes];
      [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
      return { ...current, nodes: nodes.map((node, position) => ({ ...node, position })) };
    });
  };

  const beginTaskCreate = () => {
    setEditingTask('new');
    setTaskDraft(EMPTY_TASK_DRAFT);
    setTaskError('');
  };

  const beginTaskEdit = (task: TaskItem) => {
    setEditingTask(task);
    setTaskDraft({
      code: task.code,
      title: task.title,
      description: task.description,
      assigneeId: task.assigneeId ?? '',
      status: task.status,
      dependencyIds: [...task.dependencyIds],
      acceptanceCriteria: task.acceptanceCriteria.join('\n'),
      note: task.note,
      completionRuleType: task.execution?.completionRule?.type ?? 'executor_submit',
      reviewerPartnerId: task.execution?.completionRule?.type === 'partner_review' ? task.execution.completionRule.reviewerPartnerId : '',
      autoReworkLimit: task.execution?.completionRule?.type === 'partner_review' ? task.execution.completionRule.autoReworkLimit : 2,
      workRole: task.execution?.workRole ? structuredClone(task.execution.workRole) : undefined,
      reviewWorkRole: task.execution?.reviewWorkRole ? structuredClone(task.execution.reviewWorkRole) : undefined,
      methodTemplate: task.execution?.methodTemplate ? structuredClone(task.execution.methodTemplate) : undefined,
    });
    setTaskError('');
  };

  const closeTaskEditor = () => {
    if (taskBusy) return;
    setEditingTask(undefined);
    setTaskDraft(EMPTY_TASK_DRAFT);
    setTaskError('');
  };

  const saveTask = async () => {
    if (!project || !editingTask || !taskDraft.title.trim()) return;
    setTaskBusy(true);
    setTaskError('');
    const completionRule: ProjectTaskCompletionRule = taskDraft.completionRuleType === 'partner_review'
      ? { type: 'partner_review', reviewerPartnerId: taskDraft.reviewerPartnerId, autoReworkLimit: taskDraft.autoReworkLimit }
      : { type: taskDraft.completionRuleType };
    const input = {
      projectId: project.id,
      title: taskDraft.title.trim(),
      ...(taskDraft.code.trim() ? { code: taskDraft.code.trim() } : {}),
      description: taskDraft.description.trim(),
      ...(taskDraft.assigneeId ? { assigneeId: taskDraft.assigneeId } : {}),
      status: taskDraft.status,
      dependencyIds: taskDraft.dependencyIds,
      acceptanceCriteria: taskDraft.acceptanceCriteria.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      note: taskDraft.note.trim(),
      execution: {
        ...(taskDraft.workRole ? { workRole: taskDraft.workRole } : {}),
        ...(taskDraft.completionRuleType === 'partner_review' && taskDraft.reviewWorkRole ? { reviewWorkRole: taskDraft.reviewWorkRole } : {}),
        completionRule,
        ...(taskDraft.methodTemplate ? { methodTemplate: taskDraft.methodTemplate } : {}),
      },
    };
    try {
      if (editingTask === 'new') {
        const created = await createProjectTask(input);
        setFilter('all');
        setTaskScrollTargetId(created.id);
      } else await updateProjectTask({ ...input, taskId: editingTask.id, expectedRevision: editingTask.revision });
      setEditingTask(undefined);
      setTaskDraft(EMPTY_TASK_DRAFT);
    } catch (error) {
      setTaskError(projectTaskError(error));
    } finally {
      setTaskBusy(false);
    }
  };

  const deleteTask = async () => {
    if (!project || !editingTask || editingTask === 'new') return;
    setTaskBusy(true);
    setTaskError('');
    try {
      await removeProjectTask(project.id, editingTask.id, editingTask.revision);
      setEditingTask(undefined);
      setTaskDraft(EMPTY_TASK_DRAFT);
    } catch (error) {
      setTaskError(projectTaskError(error));
    } finally {
      setTaskBusy(false);
    }
  };

  const toggleStudioMuted = async (partnerId: string, muted: boolean) => {
    if (!groupChat || !studioRoom || activeRound) return;
    await setStudioMuted(groupChat.id, muted
      ? studioRoom.mutedPartnerIds.filter((id) => id !== partnerId)
      : [...studioRoom.mutedPartnerIds, partnerId]);
    if (!muted && studioRoom.settings.selectedPartnerIds.includes(partnerId)) {
      await setStudioSettings(groupChat.id, {
        ...studioRoom.settings,
        selectedPartnerIds: studioRoom.settings.selectedPartnerIds.filter((id) => id !== partnerId),
      });
    }
  };

  const jumpToStudioMessage = (messageId: string) => {
    const target = document.getElementById(`studio-message-${messageId}`);
    if (!target) return;
    keepAtBottomRef.current = false;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedMessageId(messageId);
    window.setTimeout(() => setHighlightedMessageId((current) => current === messageId ? undefined : current), 1800);
  };

  useEffect(() => {
    if (memorySourceTarget?.kind !== 'studio') return;
    const targetGroup = state.groupChats.find((item) => item.id === memorySourceTarget.roomId && !item.archivedAt);
    if (!targetGroup || targetGroup.projectId !== memorySourceTarget.projectId || !state.projects.some((item) => item.id === targetGroup.projectId)) return;
    if (state.activeProjectId !== targetGroup.projectId) {
      selectProject(targetGroup.projectId);
      return;
    }
    if (state.activeGroupChatId !== targetGroup.id) {
      selectGroupChat(targetGroup.id);
      return;
    }
    const timer = window.setTimeout(() => {
      const target = document.getElementById(`studio-message-${memorySourceTarget.messageId}`);
      if (!target) return;
      keepAtBottomRef.current = false;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedMessageId(memorySourceTarget.messageId);
      const currentState = (location.state as MemorySourceNavigationState | null) ?? {};
      navigate(location.pathname, { replace: true, state: { ...currentState, memorySourceTarget: undefined } satisfies MemorySourceNavigationState });
      window.setTimeout(() => setHighlightedMessageId((current) => current === memorySourceTarget.messageId ? undefined : current), 1800);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [location.pathname, location.state, memorySourceTarget, navigate, selectGroupChat, selectProject, state.activeGroupChatId, state.activeProjectId, state.groupChats, state.projects]);

  const handleProjectAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setProjectDraftAvatar(typeof reader.result === 'string' ? sanitizePngDataUrl(reader.result) : undefined);
      if (projectAvatarInput.current) projectAvatarInput.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  const startRailResize = (side: 'left' | 'right' | 'preview' | 'browser', event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const initialWidth = side === 'left' ? leftRailWidth : side === 'preview' ? preview.width : side === 'browser' ? browserWidth : rightRailWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const delta = pointerEvent.clientX - startX;
      if (side === 'left') setLeftRailWidth(clamp(initialWidth + delta, 210, 340));
      else if (side === 'browser') setBrowserWidth(clamp(initialWidth - delta, 240, 480));
      else if (side === 'preview') preview.setWidth(clamp(initialWidth - delta, 320, 860));
      else setRightRailWidth(clamp(initialWidth - delta, 230, 380));
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

  const studioLayoutStyle = {
    '--studio-left-width': rails.left ? '0px' : `${leftRailWidth}px`,
    '--studio-left-gap': rails.left ? '0px' : '12px',
    '--studio-right-width': rails.right ? '0px' : `${rightRailWidth}px`,
    '--studio-right-gap': rails.right ? '0px' : '12px',
    '--studio-browser-width': browserOpen ? `${browserWidth}px` : '0px',
    '--studio-browser-gap': browserOpen ? '12px' : '0px',
    '--studio-preview-width': preview.opened ? `${preview.width}px` : '0px',
    '--studio-preview-gap': preview.opened ? '12px' : '0px',
  } as CSSProperties;

  return (
    <main className="app-grid" data-page="studio" style={studioLayoutStyle}>
      <aside hidden={rails.left} className="glass-panel left-rail studio-left">
        <Brand />
        <nav className="utility-nav" aria-label="工作室菜单">
          <button className="utility-nav-primary" type="button" onClick={openProjectConversation}><MessageSquarePlus size={19} />新建项目</button>
          <WorkspaceShortcuts studio />
        </nav>
        <div className="section-label"><span>项目与群聊</span><small>{state.projects.length}</small></div>
        <nav className="studio-project-tree scroll-region" aria-label="项目与群聊列表">
          {state.projects.map((item) => {
            const itemGroups = state.groupChats.filter((group) => group.projectId === item.id && !group.archivedAt);
            const expanded = expandedProjects.has(item.id);
            return <section className={`studio-project-group ${item.id === project?.id ? 'active' : ''}`} key={item.id}>
              <div className="studio-project-row">
                <button className="studio-project-select" type="button" aria-expanded={expanded} onClick={() => {
                  selectProject(item.id);
                  setExpandedProjects((current) => {
                    const next = new Set(current);
                    if (expanded) next.delete(item.id); else next.add(item.id);
                    return next;
                  });
                }}>
                  <ChevronDown className="studio-project-chevron" size={14} />
                  <Avatar name={item.name} src={item.avatarDataUrl} accent="#7897c9" size="sm" />
                  <span><strong>{item.name}</strong><small>{itemGroups.length} 个群聊</small></span>
                </button>
                <button className="studio-project-add" type="button" onClick={() => openGroupForProject(item.id)} aria-label={`在 ${item.name} 中新建群聊`} title="新建群聊"><Plus size={16} /></button>
              </div>
              {expanded && <div className="group-chat-nav" role="group" aria-label={`${item.name}的群聊`}>
                {itemGroups.map((chat) => <div className={`studio-group-row ${chat.id === groupChat?.id ? 'active' : ''}`} key={chat.id}>
                  <button className="studio-group-select" type="button" onClick={() => selectGroupChat(chat.id)}><MessageSquare size={14} /><span>{chat.name}</span>{chat.unreadCompletedAt && <Sparkles className="studio-unread-mark" size={12} aria-label="有伙伴完成了新回复" />}</button>
                  <button className="conversation-action" type="button" disabled={Boolean(studioRooms[chat.id]?.activeRound && !['completed', 'failed', 'cancelled'].includes(studioRooms[chat.id].activeRound!.state))} onClick={() => beginGroupEdit(chat)} aria-label={`编辑群聊名称 ${chat.name}`} title="编辑名称"><Pencil size={12} /></button>
                  <button className="conversation-action" type="button" disabled={Boolean(studioRooms[chat.id]?.activeRound && !['completed', 'failed', 'cancelled'].includes(studioRooms[chat.id].activeRound!.state))} onClick={() => archiveGroupChat(chat.id)} aria-label={`归档群聊 ${chat.name}`} title="归档群聊"><Archive size={12} /></button>
                </div>)}
                {!itemGroups.length && <button className="studio-empty-group" type="button" onClick={() => openGroupForProject(item.id)}><Plus size={13} />新建第一个群聊</button>}
              </div>}
            </section>;
          })}
        </nav>
        {project && <section className={`studio-note-card ${notesOpen ? 'is-open' : ''}`}>
          <header><button type="button" onClick={() => setNotesOpen((current) => !current)} aria-expanded={notesOpen}><StickyNote size={16} /><span>项目便签</span><small>{notes.filter((note) => note.status !== 'archived').length}</small><ChevronDown size={14} /></button></header>
          {notesOpen && <div className="studio-note-card__body">
            <form onSubmit={(event) => { event.preventDefault(); void saveNote(); }}><textarea value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} rows={2} maxLength={4000} placeholder="记下需求、Bug 或待办…" /><div>{editingNoteId && <button className="text-button" type="button" onClick={() => { setEditingNoteId(undefined); setNoteDraft(''); }}>取消编辑</button>}<button className="primary-button" type="submit" disabled={!noteDraft.trim()}>{editingNoteId ? '保存' : '添加'}</button></div></form>
            <div className="studio-note-list">{notes.filter((note) => note.status !== 'archived').map((note) => <article className={note.status === 'completed' ? 'is-completed' : ''} key={note.id}><button className="studio-note-check" type="button" onClick={() => void updateNoteStatus(note, note.status === 'completed' ? 'open' : 'completed')} aria-label={note.status === 'completed' ? `取消完成 ${note.content}` : `完成 ${note.content}`}>{note.status === 'completed' ? <CircleCheck size={16} /> : <Circle size={16} />}</button><button className="studio-note-content" type="button" onClick={() => { setEditingNoteId(note.id); setNoteDraft(note.content); }} title="编辑便签">{note.content}</button><button className="icon-button" type="button" onClick={() => void updateNoteStatus(note, 'archived')} aria-label={`归档便签 ${note.content}`} title="归档"><Archive size={13} /></button><button className="icon-button danger" type="button" onClick={() => setNoteDeleteTarget(note)} aria-label={`删除便签 ${note.content}`} title="删除"><Trash2 size={13} /></button></article>)}{!notes.some((note) => note.status !== 'archived') && <p>这里还没有便签</p>}</div>
            {notes.some((note) => note.status === 'archived') && <div className="studio-note-archive"><button className="text-button" type="button" onClick={() => setNoteArchiveOpen((current) => !current)}><ArchiveRestore size={13} />已归档（{notes.filter((note) => note.status === 'archived').length}）</button>{noteArchiveOpen && <div>{notes.filter((note) => note.status === 'archived').map((note) => <article key={note.id}><span>{note.content}</span><button className="text-button" type="button" onClick={() => void updateNoteStatus(note, 'open')}>恢复</button><button className="icon-button danger" type="button" onClick={() => setNoteDeleteTarget(note)} aria-label={`删除便签 ${note.content}`}><Trash2 size={13} /></button></article>)}</div>}</div>}
          </div>}
        </section>}
        <button className="profile-row profile-row--button" type="button" onClick={() => navigate('/profile', { state: { from: location.pathname } })} title="编辑个人资料"><Avatar name={userProfile.displayName} src={userAvatar} accent="#91a9cf" size="sm" /><span><strong>{userProfile.displayName}</strong><small>{userProfile.introduction.trim() ? userProfile.introduction.trim().slice(0, 28) : '编辑个人资料'}</small></span><MoreHorizontal size={18} /></button>
      </aside>

      <div hidden={rails.left} className="rail-resizer rail-resizer--left" role="separator" aria-label="调整工作室左侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => startRailResize('left', event)} />

      <section className="glass-panel center-stage studio-center">
        <MainHeader rails={rails} />
        <header className="project-header">
          <div className="project-header-copy">
            <h1>{groupChat?.name ?? '尚未创建群聊'}</h1>
            <div className="project-header-meta">
              <p>{project?.name ?? '还没有项目'} <span>·</span> {groupChat ? `${members.length} 位成员` : project ? '项目与文件仍保留' : '先建立一个项目'}</p>
              {projectPermissionError && <small className="project-permission-error">{projectPermissionError}</small>}
            </div>
          </div>
          {!isWork && groupChat && <div className={`studio-round-strip ${activeRound ? 'is-active' : ''}`}>
            <span><Sparkles size={14} />{activeRound?.state === 'waiting_discussion_decision' ? '讨论保护已暂停' : activeRound ? `${currentSpeaker?.publicIdentity.displayName ?? '伙伴'}正在发言` : '群聊已就绪'}</span>
            {activeRound && <div>{activeRound.members.map((member) => { const partner = members.find((item) => item.id === member.partnerId); return <span className={`studio-round-member is-${member.state}`} key={member.turnId} title={`${partner?.publicIdentity.displayName ?? '伙伴'} · ${member.state}`}><Avatar partnerId={partner?.id} name={partner?.publicIdentity.displayName ?? '伙伴'} src={partner?.publicIdentity.avatarDataUrl} accent={partner?.accent} size="sm" /></span>; })}</div>}
          </div>}
          <div className="project-header-actions">
            {project && <div className="studio-header-menu" onPointerDown={(event) => event.stopPropagation()}>
              <button className={`studio-header-control project-permission-control permission-button--${projectPermissionMode} ${openHeaderMenu === 'permission' ? 'active' : ''}`} type="button" disabled={projectPermissionBusy} aria-haspopup="menu" aria-expanded={openHeaderMenu === 'permission'} title={activeRound ? '当前轮继续使用启动时权限；修改从下一轮生效' : '项目讨论与工作区共用此权限'} onClick={() => setOpenHeaderMenu((current) => current === 'permission' ? undefined : 'permission')}><ProjectPermissionIcon size={17} /><span>{projectPermissionOption(projectPermissionMode).label}</span><ChevronDown size={13} /></button>
              {openHeaderMenu === 'permission' && <div className="studio-speaking-popover project-permission-popover" role="menu" aria-label="选择项目权限模式">
                {PROJECT_PERMISSION_OPTIONS.map((option) => { const Icon = option.icon; return <button className={projectPermissionMode === option.mode ? `active permission-button--${option.mode}` : `permission-button--${option.mode}`} type="button" role="menuitemradio" aria-checked={projectPermissionMode === option.mode} disabled={projectPermissionBusy} key={option.mode} onClick={() => void updateProjectPermission(option.mode)}><span><strong><Icon size={14} />{option.label}</strong><small>{option.description}</small></span>{projectPermissionMode === option.mode && <Check size={14} />}</button>; })}
                <p className="project-permission-hint">{activeRound ? '本次修改从下一轮生效；当前轮保持启动时权限。' : '同一项目的所有群聊与未来工作区任务共用此设置。'}</p>
              </div>}
            </div>}
            {!isWork && groupChat && <button className="studio-header-control" type="button" disabled={Boolean(activeRound) || !window.asteriumProjects?.startWorkflowGeneration} onClick={openWorkflowGeneration} title={activeRound ? '请等当前群聊轮次结束后再选择公开消息' : '选择公开消息，由一位规划伙伴生成可编辑流程草稿'}><Sparkles size={17} /><span>生成工作流</span></button>}
            <button className="studio-header-control" type="button" disabled={!groupChat || Boolean(activeRound)} onClick={beginMemberManagement}><UserPlus size={17} /><span>成员管理</span></button>
            {!isWork && groupChat && studioRoom && <div className="studio-header-menu" onPointerDown={(event) => event.stopPropagation()}>
              <button className={`studio-header-control ${openHeaderMenu === 'speaking' ? 'active' : ''}`} type="button" disabled={Boolean(activeRound)} aria-haspopup="menu" aria-expanded={openHeaderMenu === 'speaking'} onClick={() => setOpenHeaderMenu((current) => current === 'speaking' ? undefined : 'speaking')}><MessageSquare size={17} /><span>{speakingModeLabel(studioRoom.settings.speakingMode)}</span><ChevronDown size={13} /></button>
              {openHeaderMenu === 'speaking' && <div className="studio-speaking-popover" role="menu" aria-label="选择发言方式">
                {([
                  ['free_discussion', '自由讨论', '伙伴可通过 @ 邀请其他成员继续讨论'],
                  ['selected_partners', '指定发言', '每轮只由你选择的一位或多位伙伴回答'],
                  ['round_robin', '逐一回应', '每位可用伙伴按顺序各回应一次'],
                ] as const).map(([value, label, hint]) => <button className={studioRoom.settings.speakingMode === value ? 'active' : ''} type="button" role="menuitemradio" aria-checked={studioRoom.settings.speakingMode === value} key={value} onClick={() => { setOpenHeaderMenu(undefined); updateStudioSettings({ speakingMode: value }); }}><span><strong>{label}</strong><small>{hint}</small></span>{studioRoom.settings.speakingMode === value && <Check size={14} />}</button>)}
                {studioRoom.settings.speakingMode === 'selected_partners' && <div className="studio-speaking-popover__members"><small>选择固定发言伙伴</small>{mentionOptions.filter((option) => !option.disabled).map((option) => { const selected = studioRoom.settings.selectedPartnerIds.includes(option.partnerId); return <button className={selected ? 'active' : ''} type="button" aria-pressed={selected} key={option.partnerId} onClick={() => updateStudioSettings({ selectedPartnerIds: selected ? studioRoom.settings.selectedPartnerIds.filter((id) => id !== option.partnerId) : [...studioRoom.settings.selectedPartnerIds, option.partnerId] })}><Avatar name={option.displayName} src={option.avatarDataUrl} accent={option.accent} size="sm" /><span>{option.displayName}</span>{selected && <Check size={12} />}</button>; })}</div>}
              </div>}
            </div>}
            {!isWork && groupChat && studioRoom && <button className={`studio-header-control studio-protection-button ${studioRoom.settings.discussionProtectionEnabled ? 'active' : ''}`} type="button" disabled={Boolean(activeRound) || studioRoom.settings.speakingMode !== 'free_discussion'} onClick={() => updateStudioSettings({ discussionProtectionEnabled: !studioRoom.settings.discussionProtectionEnabled })} title={studioRoom.settings.speakingMode === 'free_discussion' ? '伙伴讨论多轮时提醒归纳并暂停确认' : '仅自由讨论模式可开启'}><ShieldCheck size={17} /><span>讨论保护</span></button>}
          </div>
        </header>

        {isWork ? <Workspace
          runChanges={runChanges.records}
          onViewChanges={viewRunChange}
          tasks={filteredTasks}
          allTasks={project?.tasks ?? []}
          partners={state.partners}
          attempts={taskExecutions.attempts}
          workspaceReady={project?.workspace?.status === 'ready'}
          busyTaskId={taskExecutionBusy}
          error={taskExecutionError}
          filter={filter}
          setFilter={setFilter}
          onCreate={beginTaskCreate}
          onManageRoles={() => { setShowRoleManager(true); setRoleError(''); }}
          onManageWorkflows={() => { setShowWorkflowManager(true); setWorkflowError(''); }}
          onEdit={beginTaskEdit}
          onControl={(task, action, attempt, reason) => void controlTaskExecution(task, action, attempt, reason)}
          onResolve={(task, action, feedback, affectedCriteria) => void resolveTaskGate(task, action, feedback, affectedCriteria)}
          scrollTargetId={taskScrollTargetId}
          onScrollTargetHandled={() => setTaskScrollTargetId(undefined)}
        /> : (
          <section className="discussion-view">
            <div className="message-scroll-region">
            {groupChat ? <div
              ref={messageListRef}
              className="message-list studio-messages"
              onScroll={(event) => {
                const list = event.currentTarget;
                keepAtBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 88;
              }}
            >{groupChat.messages.map((message) => {
              if (message.authorId === 'system') return <div id={`studio-message-${message.id}`} className={`studio-system-message ${highlightedMessageId === message.id ? 'is-reference-target' : ''}`} key={message.id}><span>{message.automation ? `自动化 · ${message.automation.name}\n${message.content}` : message.content}</span>{message.studioSeq && <small>#{message.studioSeq}</small>}</div>;
              const mine = isAsteriumUser(message.authorId);
              const author = mine ? undefined : state.partners.find((partner) => partner.id === message.authorId);
              const mentionLabels = message.studioMentions?.map((mention) => ({ partnerId: mention.partnerId, label: mention.label })) ?? [];
              const hasAttachedInteraction = message.id === studioInteractionMessageId;
              return <article id={`studio-message-${message.id}`} className={`message-row ${mine ? 'message-row--mine' : ''} ${highlightedMessageId === message.id ? 'is-reference-target' : ''}`} key={message.id}>
                {!mine && <Avatar partnerId={author?.id} name={author?.publicIdentity.displayName ?? '伙伴'} src={author?.publicIdentity.avatarDataUrl} accent={author?.accent} size="md" />}
                <div className="message-stack">
                  <div className="message-meta"><strong>{mine ? userProfile.displayName : `${author?.publicIdentity.displayName ?? '伙伴'}${author?.isRemoved ? '（已移除）' : ''}`}</strong>{message.studioSeq && <span className="studio-seq">#{message.studioSeq}</span>}<time>{message.createdAt}</time></div>
                  <MessageAttachmentCards attachments={message.attachments} conversationId={studioAttachmentConversationId(groupChat.id)} onPreview={(attachment) => { if (!project) return; const contextId = studioAttachmentConversationId(groupChat.id); void preview.open({ projectId: project.id, action: 'file' }, `studio-attachment:${groupChat.id}:${attachment.id}`, attachment.name, async () => { if (!window.asteriumAttachments) throw new Error('附件预览不可用'); const result = await window.asteriumAttachments.read(attachment.id, contextId); return { content: { name: attachment.name, path: attachment.name, info: result.info, text: result.text, dataUrl: result.dataUrl } }; }); }} onContextMenu={() => undefined} />
                  <div className="message-bubble"><MarkdownContent className={mine ? 'message-content--user' : ''} studioReferences={messageReferences} studioReferenceAuthors={[userProfile.displayName, ...state.partners.map((partner) => partner.publicIdentity.displayName)]} studioMentions={mentionLabels} onStudioReference={jumpToStudioMessage}>{message.content}</MarkdownContent>{hasAttachedInteraction && renderStudioInteractionTimeline()}</div>
                  {message.studioMentions?.some((mention) => mention.source === 'partner') && <div className="studio-invitation-summary"><AtSign size={12} />{message.studioMentions.filter((mention) => mention.source === 'partner').map((mention) => <span key={mention.partnerId}>已邀请 {mention.label.startsWith('@') ? mention.label : `@${mention.label}`}</span>)}</div>}
                  {!mine && !message.isStreaming && (() => { const change = runChanges.records.find((record) => record.messageId === message.id && record.roomId === groupChat.id); return change && (change.files.length > 0 || change.commits.length > 0 || change.observedChanges) ? <RunChangeSummary change={change} onView={viewRunChange} /> : null; })()}
                  {message.isStreaming && <small className="studio-message-state"><Sparkles size={11} />正在接着说</small>}
                  {message.runState === 'cancelled' && <small className="studio-message-state is-interrupted">这段回复中途停止了</small>}
                  {mine && <small className="delivery-state">已送达</small>}
                </div>
                {mine && <Avatar name={userProfile.displayName} src={userAvatar} accent="#91a9cf" size="md" />}
              </article>;
            })}{studioInteraction?.timeline.length && !studioInteractionMessageId ? <article className="message-row studio-interaction-row"><Avatar partnerId={studioInteractionPartner?.id} name={studioInteractionPartner?.publicIdentity.displayName ?? '伙伴'} src={studioInteractionPartner?.publicIdentity.avatarDataUrl} accent={studioInteractionPartner?.accent} size="md" /><div className="message-stack"><div className="message-meta"><strong>{studioInteractionPartner?.publicIdentity.displayName ?? '伙伴'}</strong></div><div className="message-bubble">{renderStudioInteractionTimeline()}</div></div></article> : null}</div> : <div className="friendly-empty"><MessageSquarePlus size={34} /><h2>{project ? '当前项目还没有群聊' : '还没有项目'}</h2><p>{project ? '项目、文件与任务仍会保留，可以新建群聊继续协作。' : '新建第一个项目和群聊，开始工作室协作。'}</p><button className="primary-button" type="button" onClick={openProjectConversation}>{project ? '新建群聊' : '新建项目'}</button></div>}
            {groupChat && <JumpToLatest key={groupChat.id} scrollRef={messageListRef} streaming={Boolean(activeRound)} partnerName={currentSpeaker?.publicIdentity.displayName} onJump={() => { keepAtBottomRef.current = true; }} />}
            </div>
        {activeRound?.state === 'waiting_discussion_decision' && <section className="studio-discussion-decision" role="alert">
          <span><Sparkles size={16} /><span><strong>伙伴已经讨论多轮</strong><small>要保留当前上下文继续，还是结束这一轮？</small></span></span>
          <div><button className="secondary-button" type="button" onClick={() => void resolveStudioDiscussion(groupChat!.id, 'end')}>结束本轮</button><button className="primary-button" type="button" onClick={() => void resolveStudioDiscussion(groupChat!.id, 'continue')}>继续讨论</button></div>
        </section>}
        {studioSendError && !isWork && <p className="studio-inline-error studio-composer-error">{studioSendError}</p>}
        {!isWork && groupChat && studioRoom?.messages.some((message) => message.projectUploadPending) && <p className="studio-inline-error studio-composer-error">
          消息已发送，附件尚未全部保存到项目上传资料。
          <button type="button" className="text-button" disabled={retryingProjectUploads} onClick={() => {
            const retry = window.asteriumStudio?.retryProjectUploads;
            if (!retry) return;
            setRetryingProjectUploads(true);
            void retry(groupChat.id).catch(() => undefined).finally(() => setRetryingProjectUploads(false));
          }}>{retryingProjectUploads ? '正在补存…' : '重试归档'}</button>
        </p>}
        {!isWork && groupChat && handoffTargets.length > 0 && <div className="context-handoff-action"><button className="text-button" type="button" onClick={() => setHandoffOpen(true)}>带上下文去单聊</button></div>}
        {!isWork && activeHandoff && <ContextHandoffDraftCard draft={activeHandoff}
          partnerName={state.partners.find(partner => partner.id === activeHandoff.partnerId)?.publicIdentity.displayName ?? '伙伴'}
          disabled={Boolean(activeRound)} onRemove={() => setContextHandoffDraft(undefined)} />}
        {!isWork && handoffOpen && groupChat && handoffTargets.length > 0 && <ContextHandoffDialog
          key={`handoff:${groupChat.id}`} source={{ kind: 'group', id: groupChat.id }} messages={groupChat.messages}
          targets={handoffTargets} partners={state.partners} onClose={() => setHandoffOpen(false)} onStage={draft => {
            setContextHandoffDraft(draft);
            selectConversation(draft.target.id);
            navigate('/chat');
          }} />}
        {!isWork && <StudioComposer
          key={groupChat?.id ?? 'empty-studio-room'}
          draftKey={groupChat ? `studio:${groupChat.id}` : undefined}
          members={mentionOptions}
          mentionsEnabled={studioRoom?.settings.speakingMode === 'free_discussion'}
          disabled={!groupChat}
          busy={Boolean(activeRound)}
          onCancel={() => groupChat && void cancelStudioRound(groupChat.id)}
          placeholder={!groupChat ? '请先新建群聊' : activeRound ? '伙伴正在发言；可以继续输入，本轮结束后再发送' : studioRoom?.settings.speakingMode === 'free_discussion' ? '输入消息；输入 @ 可选择伙伴' : studioRoom?.settings.speakingMode === 'selected_partners' ? '输入消息；仅由已选伙伴回答' : '输入消息；每位伙伴依次回应一次'}
          onSend={submitStudioMessage}
        />}
          </section>
        )}
      </section>

      {browserOpen && <div className="rail-resizer studio-browser-resizer" role="separator" tabIndex={0} aria-label="调整项目浏览宽度" aria-orientation="vertical" onPointerDown={(event) => startRailResize('browser', event)} onKeyDown={(event) => { if (event.key === 'ArrowLeft') setBrowserWidth((width) => clamp(width + 20, 240, 480)); if (event.key === 'ArrowRight') setBrowserWidth((width) => clamp(width - 20, 240, 480)); }} />}
      {project && <ProjectBrowserPane change={selectedChange} onCloseChange={() => setSelectedChange(undefined)} onOpenChange={(file) => { if (!selectedChange) return; const record = selectedChange; void preview.open({ projectId: project.id, action: 'file', path: file }, `${project.id}:run:${record.id}:${file}`, `${file.split('/').at(-1)} · 本次改动`, async () => { if (!window.asteriumProjects?.readRunChange) throw new Error('改动预览不可用'); return { content: await window.asteriumProjects.readRunChange({ projectId: project.id, id: record.id, path: file }) }; }); }} key={project.id} projectId={project.id} open={browserOpen} tab={browserState.tab} onTab={(tab) => setBrowserState({ projectId: project.id, open: true, tab })} onClose={() => setBrowserState((current) => ({ ...current, open: false }))} onOpenFile={(request, key, name) => void preview.open(request, key, name)} />}
      {preview.opened && <div className="rail-resizer studio-preview-resizer" role="separator" tabIndex={0} aria-label="调整工作室预览宽度" aria-orientation="vertical" onPointerDown={(event) => startRailResize('preview', event)} onKeyDown={(event) => { if (event.key === 'ArrowLeft') preview.setWidth((width) => clamp(width + 20, 320, 860)); if (event.key === 'ArrowRight') preview.setWidth((width) => clamp(width - 20, 320, 860)); }} />}
      {preview.pane}
      <div hidden={rails.right} className="rail-resizer rail-resizer--right" role="separator" aria-label="调整工作室右侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => startRailResize('right', event)} />

      <aside hidden={rails.right} className="glass-panel right-rail studio-right">
        {project ? <><section className="studio-side-card project-summary">
          <header><button className="studio-side-card__toggle" type="button" onClick={() => setProjectSummaryOpen((current) => !current)} aria-expanded={projectSummaryOpen}><Avatar name={project.name} src={project.avatarDataUrl} accent="#7897c9" size="md" /><span><strong>{project.name}</strong></span><ChevronDown size={15} /></button><button className="icon-button project-summary__edit" type="button" onClick={beginProjectEdit} aria-label="编辑项目资料" title="编辑项目资料"><MoreHorizontal size={15} /></button></header>
          {projectSummaryOpen && <div className="studio-side-card__body"><p>{project.description}</p><div className="tag-list">{project.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><div className={`project-directory-card ${project.workspace?.status === 'ready' ? 'is-ready' : ''}`}><span className="project-directory-card__icon"><FolderKanban size={18} /></span><span><small>{project.workspace?.status === 'ready' ? '项目文件夹' : '尚未建立实体目录'}</small><strong title={project.workspace?.rootPath}>{project.workspace?.rootPath ?? '创建后会生成 3 份基础文档'}</strong></span>{project.workspace?.status === 'ready' ? <button className="icon-button" type="button" onClick={() => void window.asteriumProjects?.open(project.id)} title="打开项目文件夹"><FolderOpen size={16} /></button> : <button className="text-button" type="button" disabled={workspaceBusy} onClick={() => void initializeWorkspace()}>{workspaceBusy ? '正在创建…' : '建立文件夹'}</button>}</div>{projectError && !showNewConversation && <p className="studio-inline-error">{projectError}</p>}</div>}
        </section>
        <section className="studio-side-card project-browser-launchers"><header><span><FolderKanban size={18} />项目浏览</span></header><div className="studio-side-card__body">{([['files', '项目文件'], ['history', '提交历史'], ['status', '未提交']] as const).map(([tab, label]) => <button className="secondary-button" type="button" key={tab} disabled={project.workspace?.status !== 'ready'} aria-pressed={browserOpen && browserState.tab === tab} onClick={() => { if (window.innerWidth <= 1900) preview.minimize(); setSelectedChange(undefined); setBrowserState({ projectId: project.id, open: true, tab }); }}>{label}</button>)}</div></section>
        <section className="studio-side-card project-files-panel">
          <header className="project-files-panel__header">
            <FolderKanban className="studio-side-card__heading-icon" size={18} />
            <div className="project-files-panel__heading-copy">
              <div><button type="button" onClick={() => setProjectFilesOpen((current) => !current)} aria-expanded={projectFilesOpen}>项目文件交付</button>
                {project.workspace?.status === 'ready' && <>
                  <button className="project-files-panel__folder" type="button" onClick={() => void window.asteriumProjects?.open(project.id)} title="打开项目文件夹" aria-label="打开项目文件夹"><FolderOpen size={13} /></button>
                  <button className="project-files-panel__folder" type="button" onClick={refreshProjectFiles} title="刷新项目文件交付" aria-label="刷新项目文件交付"><RefreshCw size={13} /></button>
                </>}
              </div>
              <small>项目文件夹与交付成果</small>
            </div>
            <button className="project-files-panel__chevron" type="button" onClick={() => setProjectFilesOpen((current) => !current)} aria-expanded={projectFilesOpen} aria-label={`${projectFilesOpen ? '收起' : '展开'}项目文件交付`}><ChevronDown size={15} /></button>
          </header>
          {projectFilesOpen && <div className="studio-side-card__body"><div
            className={`delivery-list project-files-list${projectFilesScrollbarVisible ? ' project-files-list--scrollbar' : ''}`}
            aria-label="项目文件交付列表"
            onPointerMove={(event) => setProjectFilesScrollbarVisible(event.currentTarget.getBoundingClientRect().right - event.clientX <= 20)}
            onPointerLeave={() => setProjectFilesScrollbarVisible(false)}
          >{project.workspace?.status === 'ready' ? <ProjectFileTree key={project.id} projectId={project.id} refresh={projectFilesRefresh} label="项目文件交付目录"
              onOpenFile={(request, key, name) => {
                const indexed = request.action === 'file' && request.path ? project.files.find((file) => matchesProjectFilePath(file, request.path!)) : undefined;
                if (indexed?.fileId && indexed.availability !== 'missing') void preview.open({ projectId: project.id, action: 'file', fileId: indexed.fileId }, `${project.id}:file:${indexed.fileId}`, name);
                else void preview.open(request, key, name);
              }}
              onFileMenu={(path, event) => {
                const indexed = project.files.find((file) => matchesProjectFilePath(file, path));
                if (!indexed?.fileId) return;
                event.preventDefault();
                setProjectFileMenu({ fileId: indexed.fileId, x: event.clientX, y: event.clientY });
              }}
            /> : <p className="delivery-empty">请先建立项目文件夹</p>}
            {project.files.filter((file) => file.fileId && file.availability === 'missing').map((file) => <button
              className="delivery-item is-missing" type="button" aria-disabled="true" key={file.id} onContextMenu={(event) => {
                event.preventDefault();
                setProjectFileMenu({ fileId: file.fileId!, x: event.clientX, y: event.clientY });
              }}><span className="resource-icon"><FileText size={19} /></span><span><strong>{file.name}</strong><small>原文件已删除，引用已失效</small></span></button>)}
          </div></div>}
        </section></> : <section className="studio-side-card studio-empty-project-card"><div className="studio-side-card__body"><FolderKanban size={24} /><strong>还没有项目</strong><p>项目资料、成员和文件会显示在这里。</p><button className="primary-button" type="button" onClick={openProjectConversation}>新建项目</button></div></section>}
        <section className="member-panel">
          <header><span><UsersRound size={20} />群聊成员（{members.length}）</span><small>右键管理</small></header>
          {members.map((partner) => { const muted = Boolean(studioRoom?.mutedPartnerIds.includes(partner.id)); const external = partner.sourceMode === 'existing_thread'; const roomModel = studioRoom?.models[partner.id]; return <div className={`member-row ${muted ? 'is-muted' : ''}`} key={partner.id}><button className="member-row__manage" type="button" aria-label={`${partner.publicIdentity.displayName}，右键管理`} onContextMenu={(event) => { event.preventDefault(); setMemberMenu({ partnerId: partner.id, x: event.clientX, y: event.clientY }); }} onKeyDown={(event) => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMemberMenu({ partnerId: partner.id, x: rect.right - 176, y: rect.bottom }); }}><Avatar partnerId={partner.id} name={partner.publicIdentity.displayName} src={partner.publicIdentity.avatarDataUrl} accent={partner.accent} size="md" source={partner.sourceMode} /><span><strong>{partner.publicIdentity.displayName}{muted ? ' · 已禁言' : ''}</strong><small>{partner.isRemoved ? '伙伴已移除' : partner.publicIdentity.expertise || '团队成员'}</small><small className="member-model">{external ? '外部伙伴 · 异步参与' : roomModel ? `当前 · ${roomModel.model}` : partner.recentModel ? `最近 · ${partner.recentModel.model}` : partner.sourceMode === 'api_partner' ? `当前 · ${partner.model}` : '模型尚未报告'}</small></span></button><button className="member-notebook-button" type="button" disabled={!project || partner.isRemoved} title={`打开 ${partner.publicIdentity.displayName} 的项目工作笔记本`} aria-label={`打开 ${partner.publicIdentity.displayName} 的项目工作笔记本`} onClick={() => void openProjectNotebook(partner)}><NotebookPen size={15} /></button></div>; })}
          {!members.length && <p className="member-panel__empty">还没有添加群聊成员</p>}
        </section>
        <div className="studio-mode-switch"><button className={!isWork ? 'active' : ''} type="button" onClick={() => navigate('/studio/discussion')}><MessageSquare size={18} />讨论区</button><button className={isWork ? 'active' : ''} type="button" onClick={() => navigate('/studio/workspace')}><FolderKanban size={18} />工作区</button></div>
      </aside>

      {memberMenu && (() => {
        const partner = members.find((item) => item.id === memberMenu.partnerId);
        if (!partner || !groupChat) return null;
        const muted = Boolean(studioRoom?.mutedPartnerIds.includes(partner.id));
        return <div className="studio-member-context-menu" style={{ left: Math.min(memberMenu.x, window.innerWidth - 190), top: Math.min(memberMenu.y, window.innerHeight - 130) }} onPointerDown={(event) => event.stopPropagation()} role="menu">
          <button type="button" role="menuitem" disabled={Boolean(activeRound)} onClick={() => { void toggleStudioMuted(partner.id, muted); setMemberMenu(undefined); }}>{muted ? <Mic size={14} /> : <MicOff size={14} />}{muted ? '解除禁言' : '禁言'}</button>
          <hr />
          <button className="danger" type="button" role="menuitem" disabled={Boolean(activeRound)} onClick={() => { setMemberRemoveTarget(partner); setMemberMenu(undefined); }}><Trash2 size={14} />移出群聊</button>
        </div>;
      })()}

      {projectFileMenu && <div className="artifact-context-menu" style={{ left: Math.min(projectFileMenu.x, window.innerWidth - 200), top: Math.min(projectFileMenu.y, window.innerHeight - 60) }} onPointerDown={(event) => event.stopPropagation()} role="menu"><button className="danger" type="button" role="menuitem" onClick={() => void beginProjectFileDeletion(projectFileMenu.fileId)}><Trash2 size={14} />删除文件</button></div>}

      {fileDeletionInspection && <FileDeletionModal inspection={fileDeletionInspection} busy={fileDeletionBusy} error={fileDeletionError} onClose={() => { if (!fileDeletionBusy) { setFileDeletionInspection(undefined); setFileDeletionError(''); } }} onConfirm={() => void confirmProjectFileDeletion()} />}

      {showNewConversation && <NewGroupModal state={state} projectChoice={projectChoice} setProjectChoice={setProjectChoice} selectedProjectId={selectedProjectId} setSelectedProjectId={setSelectedProjectId} newProjectName={newProjectName} setNewProjectName={setNewProjectName} newProjectDescription={newProjectDescription} setNewProjectDescription={setNewProjectDescription} projectLocation={projectLocation} setProjectLocation={setProjectLocation} chooseProjectLocation={chooseProjectLocation} newGroupName={newGroupName} setNewGroupName={setNewGroupName} error={projectError} busy={projectBusy} onClose={() => !projectBusy && setShowNewConversation(false)} onSubmit={() => void submitProjectConversation()} />}

      {editingGroup && <Modal title="编辑群聊名称" description="只修改星丛侧显示名称，不影响项目文件与伙伴线程。" onClose={closeGroupEdit}><div className="modal-body"><label className="modal-field">群聊名称<input value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={50} autoFocus /></label></div><footer className="modal-footer"><button className="secondary-button" type="button" onClick={closeGroupEdit}>取消</button><button className="primary-button" type="button" disabled={!draftName.trim()} onClick={saveGroup}>保存名称</button></footer></Modal>}

      {showMembers && groupChat && <Modal size="md" title="管理群聊成员" description="加入群聊会同时加入项目；仅从群聊移除时，仍保留项目成员身份与项目工作区。" onClose={() => setShowMembers(false)}><div className="modal-body"><StudioMemberManager partners={activePartners} selectedIds={draftMembers} onChange={setDraftMembers} selectedTitle="当前群聊成员" addLabel={(partner) => `添加成员 ${partner.publicIdentity.displayName}`} removeLabel={(partner) => `取消选择 ${partner.publicIdentity.displayName}`} emptySelection="从左侧选择要加入的伙伴" /></div><footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setShowMembers(false)}>取消</button><button className="primary-button" type="button" onClick={() => void saveMembers()}>保存成员</button></footer></Modal>}

      {editingProject && <Modal size="md" title="编辑项目资料" description="项目成员会获得项目文件夹访问权限；移出项目时也会从该项目全部群聊中移除。" onClose={closeProjectEdit}><div className="modal-body"><div className="project-profile-editor"><input ref={projectAvatarInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择项目头像" hidden onChange={handleProjectAvatar} /><Avatar name={projectDraftName || editingProject.name} src={projectDraftAvatar} accent="#7897c9" size="lg" /><span><button className="secondary-button" type="button" onClick={() => projectAvatarInput.current?.click()}><Upload size={15} />{projectDraftAvatar ? '更换头像' : '选择头像'}</button>{projectDraftAvatar && <button className="text-button" type="button" onClick={() => setProjectDraftAvatar(undefined)}>移除头像</button>}</span></div><label className="modal-field">项目名称<input value={projectDraftName} onChange={(event) => setProjectDraftName(event.target.value)} maxLength={50} /></label><label className="modal-field">项目简介<textarea value={projectDraftDescription} onChange={(event) => setProjectDraftDescription(event.target.value)} maxLength={1000} /></label><div className="task-editor__row"><label className="modal-field">项目状态<select value={projectDraftStatus} onChange={(event) => setProjectDraftStatus(event.target.value as ProjectStatus)}><option value="active">进行中</option><option value="paused">已暂停</option><option value="complete">已完成</option></select></label><label className="modal-field">整体进度（%）<input type="number" min="0" max="100" value={projectDraftProgress} onChange={(event) => setProjectDraftProgress(Math.max(0, Math.min(100, Number(event.target.value) || 0)))} /></label></div><label className="modal-field">项目标签 <small>使用逗号或顿号分隔</small><input value={projectDraftTags} onChange={(event) => setProjectDraftTags(event.target.value)} maxLength={300} /></label><div className="project-member-editor"><header><strong>项目成员</strong><small>群聊成员可以少于项目成员；新增群聊默认带入这里的伙伴。</small></header><StudioMemberManager partners={activePartners} selectedIds={projectDraftMembers} onChange={setProjectDraftMembers} selectedTitle="当前项目成员" addLabel={(partner) => `添加项目成员 ${partner.publicIdentity.displayName}`} removeLabel={(partner) => `移出项目成员 ${partner.publicIdentity.displayName}`} selectedDetail={(partner) => partner.sourceMode === 'existing_thread' ? '参与项目（不自动添加本机工作区）' : '将获得项目工作区'} emptySelection="从左侧选择要加入项目的伙伴" /></div>{projectError && <p className="studio-inline-error">{projectError}</p>}</div><footer className="modal-footer project-editor-footer"><button className="danger-button project-delete-button" type="button" disabled={projectBusy} onClick={() => { setProjectDeleteTarget(editingProject); closeProjectEdit(); }}><Trash2 size={14} />删除项目</button><span><button className="secondary-button" type="button" onClick={closeProjectEdit}>取消</button><button className="primary-button" type="button" disabled={!projectDraftName.trim() || projectBusy} onClick={() => void saveProject()}>保存项目资料</button></span></footer></Modal>}

      {showRoleManager && !editingRole && !roleDeleteTarget && project && <Modal size="md" title="工作角色" description="内置、全局和项目角色只用于任务临时职责；编辑或删除角色不会改写已保存任务和冻结 Attempt。" onClose={() => !roleBusy && setShowRoleManager(false)}>
        <div className="modal-body role-manager">
          {groupWorkRoles(roleCatalog?.roles ?? []).map(([group, roles]) => <section className="role-manager__group" key={group}><header><strong>{group}</strong><small>{roles.length} 个</small></header>{roles.map((role) => <article className={role.archivedAt ? 'is-archived' : ''} key={role.id}><span><strong>{role.name}</strong><small>{role.description || role.responsibilities.join('；')}</small><em>{workRoleScopeLabel(role.scope)} · r{role.revision}{role.archivedAt ? ' · 已归档' : ''}</em></span>{role.scope !== 'builtin' && <div><button className="text-button" type="button" disabled={roleBusy} onClick={() => beginRoleEdit(role)}>编辑</button><button className="text-button" type="button" disabled={roleBusy} onClick={() => void toggleRoleArchived(role)}>{role.archivedAt ? '恢复' : '归档'}</button><button className="text-button danger" type="button" disabled={roleBusy} onClick={() => setRoleDeleteTarget(role)}>删除</button></div>}</article>)}</section>)}
          {roleCatalogError && <p className="studio-inline-error">{roleCatalogError}</p>}
          {roleError && <p className="studio-inline-error">{roleError}</p>}
        </div>
        <footer className="modal-footer"><button className="secondary-button" type="button" disabled={roleBusy} onClick={() => setShowRoleManager(false)}>关闭</button><button className="primary-button" type="button" disabled={roleBusy} onClick={beginRoleCreate}><Plus size={14} />新建自定义角色</button></footer>
      </Modal>}

      {editingRole && project && <Modal size="md" title={editingRole === 'new' ? '新建工作角色' : `编辑角色 · ${editingRole.name}`} description="角色 Prompt 不能覆盖伙伴人设、星丛安全权限、项目目录或冻结任务契约。" onClose={() => !roleBusy && setEditingRole(undefined)}>
        <div className="modal-body role-editor">
          {editingRole === 'new' && <label className="modal-field">保存范围<select value={roleDraft.scope} disabled={roleBusy} onChange={(event) => setRoleDraft((current) => ({ ...current, scope: event.target.value as WorkRoleDraft['scope'] }))}><option value="project">仅当前项目</option><option value="global">所有项目</option></select></label>}
          <label className="modal-field">角色分组 <small>选择项目阶段、已有自定义分组，或新建分组</small><select value={roleGroupOptions.includes(roleDraft.group) ? roleDraft.group : '__custom__'} disabled={roleBusy} onChange={(event) => setRoleDraft((current) => ({ ...current, group: event.target.value === '__custom__' ? '' : event.target.value }))}>{roleGroupOptions.map((group) => <option value={group} key={group}>{group}</option>)}<option value="__custom__">新建自定义分组…</option></select></label>
          {!roleGroupOptions.includes(roleDraft.group) && <label className="modal-field">自定义分组名称<input value={roleDraft.group} disabled={roleBusy} maxLength={60} onChange={(event) => setRoleDraft((current) => ({ ...current, group: event.target.value }))} placeholder="例如：发布准备" autoFocus /></label>}
          <label className="modal-field">角色名称<input value={roleDraft.name} disabled={roleBusy} maxLength={80} onChange={(event) => setRoleDraft((current) => ({ ...current, name: event.target.value }))} /></label>
          <label className="modal-field">角色简介<textarea value={roleDraft.description} disabled={roleBusy} maxLength={2000} onChange={(event) => setRoleDraft((current) => ({ ...current, description: event.target.value }))} placeholder="帮助用户理解这个角色适合什么工作" /></label>
          <label className="modal-field">职责 <small>每行一项</small><textarea value={roleDraft.responsibilities} disabled={roleBusy} onChange={(event) => setRoleDraft((current) => ({ ...current, responsibilities: event.target.value }))} placeholder={'核对现有边界\n完成冻结任务\n提供可验证证据'} /></label>
          <label className="modal-field">角色 Prompt<textarea value={roleDraft.prompt} disabled={roleBusy} maxLength={20000} onChange={(event) => setRoleDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder="只填写工作方法和判断重点，不重复安全或权限规则" /></label>
          {roleError && <p className="studio-inline-error">{roleError}</p>}
        </div>
        <footer className="modal-footer"><button className="secondary-button" type="button" disabled={roleBusy} onClick={() => setEditingRole(undefined)}>取消</button><button className="primary-button" type="button" disabled={roleBusy || !roleDraft.group.trim() || !roleDraft.name.trim() || !roleDraft.responsibilities.trim()} onClick={() => void saveRole()}>{roleBusy ? '正在保存…' : '保存角色'}</button></footer>
      </Modal>}

      {roleDeleteTarget && <Modal title="删除工作角色？" description={`删除「${roleDeleteTarget.name}」只会让它不能再被选择；已有任务和冻结 Attempt 中的角色快照保持不变。`} onClose={() => !roleBusy && setRoleDeleteTarget(undefined)}><footer className="modal-footer"><button className="secondary-button" type="button" disabled={roleBusy} onClick={() => setRoleDeleteTarget(undefined)}>取消</button><button className="danger-button" type="button" disabled={roleBusy} onClick={() => void deleteRole()}>{roleBusy ? '正在删除…' : '删除角色'}</button></footer></Modal>}

      {showWorkflowGeneration && project && groupChat && <Modal size="md" title="从讨论生成工作流" description="选择任意多条当前项目群聊的公开消息，由一位规划伙伴整理为可编辑草稿；生成不会创建任务或开始执行。" onClose={() => !workflowGenerationBusy && setShowWorkflowGeneration(false)}>
        <div className="modal-body workflow-generation">
          {activeWorkflowGeneration ? <section className={`workflow-generation__status is-${activeWorkflowGeneration.status}`}>
            <span>{activeWorkflowGeneration.status === 'running' ? <Loader2 className="spin" size={18} /> : activeWorkflowGeneration.status === 'submitted' ? <CircleCheck size={18} /> : <Circle size={18} />}</span>
            <div><strong>{workflowGenerationStatusLabel(activeWorkflowGeneration.status)}</strong><small>{activeWorkflowGeneration.status === 'running' ? '规划伙伴只能提交结构化 DAG 草稿，不能读取项目文件、激活流程或创建任务。' : activeWorkflowGeneration.error?.message ? friendlyRuntimeErrorMessage(activeWorkflowGeneration.error.message) : `已冻结 ${activeWorkflowGeneration.sourceMessages.length} 条公开消息作为生成依据。`}</small>{activeWorkflowGeneration.error?.code && <code>错误码：{activeWorkflowGeneration.error.code}</code>}</div>
          </section> : <>
            <label className="modal-field">规划伙伴<select value={workflowGenerationPlannerId} disabled={workflowGenerationBusy} onChange={(event) => setWorkflowGenerationPlannerId(event.target.value)}><option value="">请选择一位规划伙伴</option>{mentionOptions.map((option) => <option value={option.partnerId} disabled={option.disabled} key={option.partnerId}>{option.displayName}{option.disabledReason ? `（${option.disabledReason}）` : ''}</option>)}</select></label>
            <section className="workflow-generation__sources">
              <header><span><strong>公开消息来源</strong><small>可同时选择伙伴总结和核心讨论；Main 会按 messageId 校验并按公开序号冻结。</small></span><div><button className="text-button" type="button" disabled={workflowGenerationBusy} onClick={() => setWorkflowGenerationMessageIds(workflowGenerationMessages.map((message) => message.id))}>全选</button><button className="text-button" type="button" disabled={workflowGenerationBusy} onClick={() => setWorkflowGenerationMessageIds([])}>清空</button></div></header>
              <div className="workflow-generation__message-list">{workflowGenerationMessages.map((message) => {
                const author = isAsteriumUser(message.authorId) ? userProfile.displayName : message.authorId === 'system' ? '系统' : state.partners.find((partner) => partner.id === message.authorId)?.publicIdentity.displayName ?? message.authorId;
                const checked = workflowGenerationMessageIds.includes(message.id);
                return <label className={checked ? 'is-selected' : ''} key={message.id}><input type="checkbox" checked={checked} disabled={workflowGenerationBusy} onChange={(event) => setWorkflowGenerationMessageIds((current) => event.target.checked ? [...current, message.id] : current.filter((id) => id !== message.id))} /><span><strong>#{message.studioSeq} · {author}</strong><small>{message.content.replace(/\s+/g, ' ').slice(0, 240) || '（空消息）'}</small></span></label>;
              })}{!workflowGenerationMessages.length && <p>当前群聊还没有可选的公开消息。</p>}</div>
              <footer><span>已选 {workflowGenerationMessageIds.length} 条</span><span>{workflowGenerationSelectedCharacters.toLocaleString('zh-CN')} / 80,000 字符</span></footer>
            </section>
          </>}
          {workflowGenerationError && <p className="studio-inline-error">{workflowGenerationError}</p>}
        </div>
        <footer className="modal-footer">
          <button className="secondary-button" type="button" disabled={workflowGenerationBusy} onClick={() => setShowWorkflowGeneration(false)}>关闭</button>
          {activeWorkflowGeneration?.status === 'running' ? <button className="danger-button" type="button" disabled={workflowGenerationBusy} onClick={() => void cancelWorkflowGeneration()}>{workflowGenerationBusy ? '正在取消…' : '取消生成'}</button> : activeWorkflowGeneration && ['failed', 'cancelled', 'interrupted'].includes(activeWorkflowGeneration.status) ? <><button className="secondary-button" type="button" disabled={workflowGenerationBusy} onClick={() => { setWorkflowGenerationPlannerId(activeWorkflowGeneration.plannerPartnerId); setWorkflowGenerationMessageIds(activeWorkflowGeneration.sourceMessages.map((message) => message.messageId)); setActiveWorkflowGenerationId(undefined); setWorkflowGenerationError(''); }}>重新选择</button><button className="primary-button" type="button" disabled={workflowGenerationBusy} onClick={() => void retryWorkflowGeneration()}>{workflowGenerationBusy ? '正在重试…' : '使用原消息重试'}</button></> : !activeWorkflowGeneration ? <button className="primary-button" type="button" disabled={workflowGenerationBusy || !workflowGenerationPlannerId || !workflowGenerationMessageIds.length || workflowGenerationMessageIds.length > 160 || workflowGenerationSelectedCharacters > 80_000} onClick={() => void startWorkflowGeneration()}>{workflowGenerationBusy ? <><Loader2 className="spin" size={15} />正在启动…</> : '生成可编辑草稿'}</button> : null}
        </footer>
      </Modal>}

      {showWorkflowManager && !showWorkflowTemplates && !editingWorkflow && !workflowDeleteTarget && project && <Modal size="md" title="工作流程" description="草稿可以继续编辑；确认执行后会形成独立的运行记录。" onClose={closeWorkflowWindows}>
        <div className="modal-body workflow-manager">
          <section className="workflow-manager__group"><h3>流程草稿</h3>
            {workflowDrafts.length ? workflowDrafts.map((workflow) => <article key={workflow.id}>
              <span><strong>{workflow.name}</strong><small>{workflow.description || '未填写流程说明'}</small><em>草稿 · {workflow.nodes.length} 个步骤{workflow.generationProvenance ? ` · 讨论生成（${workflow.generationProvenance.messageRefs.length} 条来源）` : ''} · r{workflow.revision}</em></span>
              <div><button className="text-button" type="button" disabled={workflowBusy} onClick={() => { setEditingWorkflow(structuredClone(workflow)); setWorkflowActivationId(crypto.randomUUID()); setWorkflowError(''); }}>编辑</button><button className="text-button danger" type="button" disabled={workflowBusy} onClick={() => setWorkflowDeleteTarget(workflow)}>删除</button></div>
            </article>) : <p>暂无草稿，可以从空白流程或内置模板开始。</p>}
          </section>
          {workflowRuns.length > 0 && <section className="workflow-manager__group"><h3>运行记录</h3>
            {workflowRuns.map((workflow) => {
              const missingTasks = workflow.activatedTasks?.filter((mapping) => !projectTaskIds.has(mapping.taskId)).length ?? 0;
              return <article key={workflow.id}>
                <span><strong>{workflow.name}</strong><small>{workflow.description || '未填写流程说明'}</small><em>{workflowStatusLabel(workflow)} · {workflow.nodes.length} 个步骤{missingTasks ? ` · ${missingTasks} 个关联任务已移除` : ''} · r{workflow.revision}</em></span>
                <div>{(workflow.status === 'completed' || workflow.status === 'cancelled') && <button className="text-button danger" type="button" disabled={workflowBusy} onClick={() => setWorkflowDeleteTarget(workflow)}>移除记录</button>}</div>
              </article>;
            })}
          </section>}
          {workflowError && <p className="studio-inline-error">{workflowError}</p>}
        </div>
        <footer className="modal-footer"><button className="secondary-button" type="button" disabled={workflowBusy} onClick={closeWorkflowWindows}>关闭</button><button className="primary-button" type="button" disabled={workflowBusy} onClick={() => setShowWorkflowTemplates(true)}><Plus size={14} />从模板创建</button></footer>
      </Modal>}

      {showWorkflowTemplates && !editingWorkflow && !workflowTemplateDeleteTarget && project && <Modal size="md" title="从模板创建流程" description="模板只生成可编辑草稿；不会自动分配伙伴或开始执行。" onClose={closeWorkflowWindows}>
        <div className="modal-body workflow-template-list">
          {(workflowCatalog?.templates ?? []).map((template) => <article className={template.kind === 'project' ? 'has-actions' : undefined} key={template.id}>
            <button className="workflow-template-list__main" type="button" disabled={workflowBusy} onClick={() => void createWorkflowFromTemplate(template.id)}><span><strong>{template.name}</strong><small>{template.description}</small><em>{template.kind === 'project' ? `当前项目 · r${template.revision}` : '星丛内置'} · {template.nodeCount ? `${template.nodeCount} 个步骤` : '空白 DAG'}{template.sourceAttribution ? ' · 含来源说明' : ''}</em></span><ChevronRight className="workflow-template-list__arrow" size={16} aria-hidden="true" /></button>
            {template.kind === 'project' && <div className="workflow-template-list__actions"><button className="text-button danger" type="button" disabled={workflowBusy} onClick={() => setWorkflowTemplateDeleteTarget(template)}>删除</button></div>}
          </article>)}
          {!workflowCatalog?.templates.length && <p>流程模板读取失败，请关闭后重试。</p>}
          {workflowError && <p className="studio-inline-error">{workflowError}</p>}
        </div>
        <footer className="modal-footer"><button className="secondary-button" type="button" disabled={workflowBusy} onClick={() => setShowWorkflowTemplates(false)}>取消</button></footer>
      </Modal>}

      {editingWorkflow && !workflowTemplateDialog && project && <Modal size="md" title={`编辑流程 · ${editingWorkflow.name}`} description="依赖关系是显式 DAG；保存仍是草稿，只有“确认执行”会一次性创建全部任务与 Attempt。" onClose={closeWorkflowWindows}>
        <div className="modal-body workflow-editor">
          {editingWorkflow.generationProvenance && <div className="workflow-generation-provenance"><strong>由项目公开讨论生成</strong><span>{editingWorkflow.generationProvenance.generationSummary}</span><small>规划伙伴：{state.partners.find((partner) => partner.id === editingWorkflow.generationProvenance?.plannerPartnerId)?.publicIdentity.displayName ?? editingWorkflow.generationProvenance.plannerPartnerId} · 来源消息：{editingWorkflow.generationProvenance.messageRefs.map((reference) => `#${reference.seq}`).join('、')}</small></div>}
          {editingWorkflow.generationWarnings?.length ? <div className="workflow-template-warning"><strong>生成引用需要确认</strong>{editingWorkflow.generationWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
          {editingWorkflow.templateWarnings?.length ? <div className="workflow-template-warning"><strong>模板引用需要确认</strong>{editingWorkflow.templateWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
          <label className="modal-field">流程名称<input value={editingWorkflow.name} disabled={workflowBusy} maxLength={160} onChange={(event) => setEditingWorkflow((current) => current ? { ...current, name: event.target.value } : current)} /></label>
          <label className="modal-field">流程说明<textarea value={editingWorkflow.description} disabled={workflowBusy} maxLength={4000} onChange={(event) => setEditingWorkflow((current) => current ? { ...current, description: event.target.value } : current)} /></label>
          <header className="workflow-editor__heading"><span><strong>步骤 DAG</strong><small>上下移动只改变显示顺序；实际调度只看显式依赖。</small></span>{!editingWorkflow.nodes.length && <button className="secondary-button" type="button" disabled={workflowBusy} onClick={addWorkflowNode}><Plus size={14} />增加步骤</button>}</header>
          <div className="workflow-node-list">{editingWorkflow.nodes.map((node, index) => <WorkflowNodeEditor
            key={node.id}
            node={node}
            nodes={editingWorkflow.nodes}
            partners={state.partners.filter((partner) => project.memberIds.includes(partner.id))}
            roles={roleCatalog?.roles ?? []}
            methods={workflowCatalog?.methods ?? []}
            generationBasis={(() => {
              const basis = editingWorkflow.generationProvenance?.nodeBasis.find((item) => item.draftNodeId === node.id);
              if (!basis) return undefined;
              const references = new Map(editingWorkflow.generationProvenance?.messageRefs.map((item) => [item.messageId, item.seq]));
              return { summary: basis.summary, sourceSeqs: basis.sourceMessageIds.flatMap((id) => references.get(id) ?? []) };
            })()}
            disabled={workflowBusy}
            canMoveUp={index > 0}
            canMoveDown={index < editingWorkflow.nodes.length - 1}
            onChange={(update) => updateWorkflowNode(node.id, update)}
            onMove={(offset) => moveWorkflowNode(node.id, offset)}
            onRemove={() => removeWorkflowNode(node.id)}
          />)}{editingWorkflow.nodes.length > 0 && <button className="workflow-add-node" type="button" disabled={workflowBusy} onClick={addWorkflowNode}><Plus size={14} />在步骤 {editingWorkflow.nodes.length} 后增加步骤</button>}{!editingWorkflow.nodes.length && <div className="friendly-empty workflow-empty"><FolderKanban size={28} /><h2>这是空白流程</h2><p>增加步骤后再分配伙伴、角色、方法与依赖。</p></div>}</div>
          {workflowError && <p className="studio-inline-error">{workflowError}</p>}
        </div>
        <footer className="modal-footer workflow-editor__footer"><button className="secondary-button" type="button" disabled={workflowBusy} onClick={() => { setEditingWorkflow(undefined); setWorkflowActivationId(''); }}>取消</button><button className="secondary-button" type="button" disabled={workflowBusy || !editingWorkflow.name.trim()} onClick={() => openWorkflowTemplateDialog('new')}>另存为模板</button>{editingSourceTemplate && <button className="secondary-button" type="button" disabled={workflowBusy || !editingWorkflow.name.trim()} onClick={() => openWorkflowTemplateDialog('update')}>更新源模板</button>}<button className="secondary-button" type="button" disabled={workflowBusy || !editingWorkflow.name.trim()} onClick={() => void saveWorkflow()}>{workflowBusy ? '正在保存…' : '保存草稿'}</button><button className="primary-button" type="button" disabled={workflowBusy || !editingWorkflow.name.trim() || !editingWorkflow.nodes.length || editingWorkflow.nodes.some((node) => !node.title.trim() || !node.assigneeId || (node.execution?.completionRule?.type === 'partner_review' && (!node.execution.completionRule.reviewerPartnerId || !node.acceptanceCriteria.length)))} onClick={() => void activateWorkflow()}>确认执行</button></footer>
      </Modal>}

      {workflowTemplateDialog && editingWorkflow && <Modal title={workflowTemplateDialog === 'new' ? '另存为项目模板' : '更新项目模板'} description={workflowTemplateDialog === 'new' ? '保存当前草稿的流程结构；后续修改模板不会改变这个草稿。' : '用当前草稿覆盖源模板；已生成的其他草稿和任务不会变化。'} onClose={closeWorkflowWindows}><div className="modal-body"><label className="modal-field">模板名称<input value={workflowTemplateName} disabled={workflowBusy} maxLength={120} onChange={(event) => setWorkflowTemplateName(event.target.value)} autoFocus /></label><label className="modal-field">模板说明<textarea value={workflowTemplateDescription} disabled={workflowBusy} maxLength={4000} onChange={(event) => setWorkflowTemplateDescription(event.target.value)} /></label>{workflowError && <p className="studio-inline-error">{workflowError}</p>}</div><footer className="modal-footer"><button className="secondary-button" type="button" disabled={workflowBusy} onClick={() => setWorkflowTemplateDialog(undefined)}>取消</button><button className="primary-button" type="button" disabled={workflowBusy || !workflowTemplateName.trim()} onClick={() => void saveWorkflowTemplate()}>{workflowBusy ? '正在保存…' : workflowTemplateDialog === 'new' ? '保存模板' : '更新模板'}</button></footer></Modal>}

      {workflowTemplateDeleteTarget && <Modal title="删除项目模板？" description={`删除「${workflowTemplateDeleteTarget.name}」只会移除模板；由它生成的草稿、任务和运行记录保持不变。`} onClose={closeWorkflowWindows}>{workflowError && <div className="modal-body"><p className="studio-inline-error">{workflowError}</p></div>}<footer className="modal-footer"><button className="secondary-button" type="button" disabled={workflowBusy} onClick={() => setWorkflowTemplateDeleteTarget(undefined)}>取消</button><button className="danger-button" type="button" disabled={workflowBusy} onClick={() => void deleteWorkflowTemplate()}>{workflowBusy ? '正在删除…' : '删除模板'}</button></footer></Modal>}

      {workflowDeleteTarget && <Modal title={workflowDeleteTarget.status === 'draft' ? '删除流程草稿？' : '移除流程运行记录？'} description={workflowDeleteTarget.status === 'draft' ? `删除「${workflowDeleteTarget.name}」后无法恢复。` : `只移除「${workflowDeleteTarget.name}」的流程记录，不会删除或修改项目任务。`} onClose={closeWorkflowWindows}>{workflowError && <div className="modal-body"><p className="studio-inline-error">{workflowError}</p></div>}<footer className="modal-footer"><button className="secondary-button" type="button" disabled={workflowBusy} onClick={() => setWorkflowDeleteTarget(undefined)}>取消</button><button className="danger-button" type="button" disabled={workflowBusy} onClick={() => void deleteWorkflow()}>{workflowBusy ? '正在处理…' : workflowDeleteTarget.status === 'draft' ? '删除草稿' : '移除记录'}</button></footer></Modal>}

      {editingTask && project && <Modal size="md" title={editingTask === 'new' ? '新建任务' : `编辑任务 · ${editingTask.code}`} description="任务数据由星丛主进程统一保存；依赖仅能指向当前项目中的其他任务。" onClose={closeTaskEditor}>
        <div className="modal-body task-editor">
          <div className="task-editor__row">
            <label className="modal-field">任务编号
              <small>留空自动生成</small>
              <input value={taskDraft.code} disabled={taskBusy} onChange={(event) => setTaskDraft((current) => ({ ...current, code: event.target.value }))} maxLength={32} placeholder="TSK-001" />
            </label>
            <label className="modal-field task-editor__status">状态
              <select value={taskDraft.status} disabled={taskBusy} onChange={(event) => setTaskDraft((current) => ({ ...current, status: event.target.value as ProjectTaskStatus }))}>
                {TASK_STATUS_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
          </div>
          <label className="modal-field">任务名称<input value={taskDraft.title} disabled={taskBusy} onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))} maxLength={160} autoFocus /></label>
          <label className="modal-field">任务说明<textarea value={taskDraft.description} disabled={taskBusy} onChange={(event) => setTaskDraft((current) => ({ ...current, description: event.target.value }))} maxLength={20000} placeholder="说明目标、范围和期望结果" /></label>
          <label className="modal-field">负责人<select value={taskDraft.assigneeId} disabled={taskBusy} onChange={(event) => setTaskDraft((current) => ({ ...current, assigneeId: event.target.value, reviewerPartnerId: current.reviewerPartnerId === event.target.value ? '' : current.reviewerPartnerId }))}><option value="">暂不分配</option>{project.memberIds.map((partnerId) => { const partner = state.partners.find((item) => item.id === partnerId); return <option value={partnerId} key={partnerId}>{partner?.publicIdentity.displayName ?? partnerId}{partner?.isRemoved ? '（已移除）' : ''}</option>; })}</select></label>
          <WorkRoleSelect label="执行角色" value={taskDraft.workRole} roles={roleCatalog?.roles ?? []} disabled={taskBusy} emptyLabel="默认任务执行者" onChange={(workRole) => setTaskDraft((current) => ({ ...current, workRole }))} />
          <WorkMethodSelect label="方法模板" value={taskDraft.methodTemplate} methods={workflowCatalog?.methods ?? []} disabled={taskBusy} emptyLabel="不使用方法模板" onChange={(methodTemplate) => setTaskDraft((current) => ({ ...current, methodTemplate }))} />
          <fieldset className="task-editor__dependencies"><legend>前置依赖</legend>{project.tasks.filter((task) => editingTask === 'new' || task.id !== editingTask.id).map((task) => <label key={task.id}><input type="checkbox" disabled={taskBusy} checked={taskDraft.dependencyIds.includes(task.id)} onChange={(event) => setTaskDraft((current) => ({ ...current, dependencyIds: event.target.checked ? [...current.dependencyIds, task.id] : current.dependencyIds.filter((id) => id !== task.id) }))} /><span><strong>{task.code}</strong>{task.title}</span></label>)}{project.tasks.length <= (editingTask === 'new' ? 0 : 1) && <p>当前没有其他任务可作为依赖。</p>}</fieldset>
          <label className="modal-field">验收标准 <small>每行一项</small><textarea value={taskDraft.acceptanceCriteria} disabled={taskBusy} onChange={(event) => setTaskDraft((current) => ({ ...current, acceptanceCriteria: event.target.value }))} placeholder={'例如：\n核心流程可以完成\n失败状态有明确提示'} /></label>
          <label className="modal-field">完成规则<select value={taskDraft.completionRuleType} disabled={taskBusy} onChange={(event) => setTaskDraft((current) => ({ ...current, completionRuleType: event.target.value as ProjectTaskCompletionRule['type'] }))}><option value="executor_submit">执行者提交后自动完成</option><option value="partner_review">指定伙伴独立复核</option><option value="user_confirm">必须等待用户确认</option></select></label>
          {taskDraft.completionRuleType === 'partner_review' && <div className="task-editor__row"><label className="modal-field">复核伙伴<select value={taskDraft.reviewerPartnerId} disabled={taskBusy} onChange={(event) => setTaskDraft((current) => ({ ...current, reviewerPartnerId: event.target.value }))}><option value="">请选择复核伙伴</option>{project.memberIds.filter((partnerId) => partnerId !== taskDraft.assigneeId).map((partnerId) => { const partner = state.partners.find((item) => item.id === partnerId); return <option value={partnerId} key={partnerId}>{partner?.publicIdentity.displayName ?? partnerId}{partner?.isRemoved ? '（已移除）' : ''}</option>; })}</select></label><label className="modal-field">自动返工上限<input type="number" min="0" max="10" value={taskDraft.autoReworkLimit} disabled={taskBusy} onChange={(event) => setTaskDraft((current) => ({ ...current, autoReworkLimit: Math.max(0, Math.min(10, Number(event.target.value) || 0)) }))} /></label></div>}
          {taskDraft.completionRuleType === 'partner_review' && <WorkRoleSelect label="复核角色" value={taskDraft.reviewWorkRole} roles={roleCatalog?.roles ?? []} disabled={taskBusy} emptyLabel="默认独立复核" onChange={(reviewWorkRole) => setTaskDraft((current) => ({ ...current, reviewWorkRole }))} hint="角色只补充审计重点；不得覆盖只检查、不修改的复核强制边界。" />}
          <label className="modal-field">当前备注<textarea value={taskDraft.note} disabled={taskBusy} onChange={(event) => setTaskDraft((current) => ({ ...current, note: event.target.value }))} maxLength={20000} placeholder="记录当前进展、阻塞原因或交付结果" /></label>
          {taskError && <p className="studio-inline-error">{taskError}</p>}
        </div>
        <footer className="modal-footer project-editor-footer">{editingTask !== 'new' ? <button className="danger-button project-delete-button" type="button" disabled={taskBusy} onClick={() => void deleteTask()}><Trash2 size={14} />删除任务</button> : <span />}
          <span><button className="secondary-button" type="button" disabled={taskBusy} onClick={closeTaskEditor}>取消</button><button className="primary-button" type="button" disabled={taskBusy || !taskDraft.title.trim() || (taskDraft.completionRuleType === 'partner_review' && (!taskDraft.reviewerPartnerId || !taskDraft.acceptanceCriteria.trim()))} onClick={() => void saveTask()}>{taskBusy ? '正在保存…' : '保存任务'}</button></span>
        </footer>
      </Modal>}

      {projectDeleteTarget && <Modal title="删除项目？" description={`将从星丛中删除「${projectDeleteTarget.name}」的项目资料、任务配置和项目便签；现有 Studio 群聊与伙伴项目工作笔记本会移入归档。不会删除磁盘上的现有文件、聊天记录、单聊或伙伴原生线程。`} onClose={() => !projectBusy && setProjectDeleteTarget(undefined)}>{projectError && <div className="modal-body"><p className="studio-inline-error">{projectError}</p></div>}<footer className="modal-footer"><button className="secondary-button" type="button" disabled={projectBusy} onClick={() => setProjectDeleteTarget(undefined)}>取消</button><button className="danger-button" type="button" disabled={projectBusy} onClick={() => void deleteProject()}>{projectBusy ? '正在删除…' : '删除项目'}</button></footer></Modal>}

      {memberRemoveTarget && groupChat && <Modal title="移出群聊？" description={`将「${memberRemoveTarget.publicIdentity.displayName}」移出当前群聊。TA 仍是项目成员，项目工作区不会被移除。`} onClose={() => setMemberRemoveTarget(undefined)}><footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setMemberRemoveTarget(undefined)}>取消</button><button className="primary-button danger-confirm" type="button" onClick={() => { void setGroupMembers(groupChat.id, groupChat.memberIds.filter((id) => id !== memberRemoveTarget.id)); setMemberRemoveTarget(undefined); }}>确认移除</button></footer></Modal>}
      {noteDeleteTarget && <Modal title="删除便签？" description="删除后无法恢复；这只影响你自己的项目便签。" onClose={() => setNoteDeleteTarget(undefined)}><div className="modal-body"><p>{noteDeleteTarget.content}</p></div><footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setNoteDeleteTarget(undefined)}>取消</button><button className="danger-button" type="button" onClick={() => { void window.asteriumStudioNotes?.delete(noteDeleteTarget.id).then(() => setNotes((current) => current.filter((item) => item.id !== noteDeleteTarget.id))); setNoteDeleteTarget(undefined); }}>删除</button></footer></Modal>}
      {notebookTarget && project && <Modal size="lg" title={`${notebookTarget.publicIdentity.displayName} · ${project.name}工作笔记本`} description="这是该伙伴在当前项目中的私有工作笔记，不属于长期记忆系统，其他伙伴不可查看。" onClose={() => !projectNotebookBusy && setNotebookTarget(undefined)}><div className="modal-body"><label className="modal-field project-notebook-editor">Markdown<textarea value={projectNotebookDraft} disabled={projectNotebookBusy} onChange={(event) => setProjectNotebookDraft(event.target.value)} placeholder="记录项目背景、进展、约定和待办…" /></label><small className="project-notebook-revision">{projectNotebook ? `当前版本 r${projectNotebook.revision} · ${new Date(projectNotebook.updatedAt).toLocaleString('zh-CN')}` : projectNotebookBusy ? '正在读取…' : '尚未创建，保存后生成第一版'}</small>{projectNotebookError && <p className="studio-inline-error">{projectNotebookError}</p>}</div><footer className="modal-footer"><button className="secondary-button" type="button" disabled={projectNotebookBusy} onClick={() => setNotebookTarget(undefined)}>关闭</button><button className="primary-button" type="button" disabled={projectNotebookBusy} onClick={() => void saveProjectNotebook()}>{projectNotebookBusy ? '处理中…' : '保存笔记'}</button></footer></Modal>}
    </main>
  );
}

function WorkRoleSelect({ label, value, roles, disabled, emptyLabel, hint, onChange }: {
  label: string;
  value?: ProjectTaskWorkRole;
  roles: ProjectWorkRoleDefinition[];
  disabled: boolean;
  emptyLabel: string;
  hint?: string;
  onChange: (value?: ProjectTaskWorkRole) => void;
}) {
  const selectable = roles.filter((role) => !role.archivedAt);
  const currentKey = value?.roleId && value.roleRevision ? `${value.roleId}@${value.roleRevision}` : '';
  const currentDefinition = selectable.find((role) => `${role.id}@${role.revision}` === currentKey);
  const selectValue = value ? currentDefinition ? currentKey : '__snapshot__' : '';
  return <label className="modal-field">{label}{hint && <small>{hint}</small>}<select value={selectValue} disabled={disabled} onChange={(event) => {
    if (!event.target.value) onChange(undefined);
    else if (event.target.value !== '__snapshot__') {
      const selected = selectable.find((role) => `${role.id}@${role.revision}` === event.target.value);
      if (selected) onChange(projectWorkRoleSnapshot(selected));
    }
  }}><option value="">{emptyLabel}</option>{value && !currentDefinition && <option value="__snapshot__">当前已保存快照 · {value.name}{value.roleRevision ? ` r${value.roleRevision}` : ''}</option>}{groupWorkRoles(selectable).map(([group, grouped]) => <optgroup label={group} key={group}>{grouped.map((role) => <option value={`${role.id}@${role.revision}`} key={role.id}>{role.name} · {workRoleScopeLabel(role.scope)} · r{role.revision}</option>)}</optgroup>)}</select></label>;
}

function workRoleGroupNames(roles: ProjectWorkRoleDefinition[]) {
  const custom = roles.map((role) => role.group || DEFAULT_PROJECT_WORK_ROLE_GROUP)
    .filter((group) => !PROJECT_WORK_ROLE_GROUPS.some((preset) => preset === group))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  return [...PROJECT_WORK_ROLE_GROUPS, ...new Set(custom)];
}

function groupWorkRoles(roles: ProjectWorkRoleDefinition[]): Array<[string, ProjectWorkRoleDefinition[]]> {
  return workRoleGroupNames(roles).map<[string, ProjectWorkRoleDefinition[]]>((group) => [
    group,
    roles.filter((role) => (role.group || DEFAULT_PROJECT_WORK_ROLE_GROUP) === group),
  ]).filter(([, grouped]) => grouped.length > 0);
}

function workRoleScopeLabel(scope: ProjectWorkRoleDefinition['scope']) {
  return scope === 'builtin' ? '星丛内置' : scope === 'global' ? '全局自定义' : '当前项目';
}

function WorkMethodSelect({ label, value, methods, disabled, emptyLabel, onChange }: {
  label: string;
  value?: ProjectTaskMethodTemplate;
  methods: ProjectMethodTemplateDefinition[];
  disabled: boolean;
  emptyLabel: string;
  onChange: (value?: ProjectTaskMethodTemplate) => void;
}) {
  const currentKey = value ? `${value.templateId}@${value.version}` : '';
  const currentDefinition = methods.find((method) => `${method.templateId}@${method.version}` === currentKey);
  const selectValue = value ? currentDefinition ? currentKey : '__snapshot__' : '';
  return <label className="modal-field">{label}<select value={selectValue} disabled={disabled} onChange={(event) => {
    if (!event.target.value) onChange(undefined);
    else if (event.target.value !== '__snapshot__') {
      const selected = methods.find((method) => `${method.templateId}@${method.version}` === event.target.value);
      if (selected) onChange(projectMethodTemplateSnapshot(selected));
    }
  }}><option value="">{emptyLabel}</option>{value && !currentDefinition && <option value="__snapshot__">当前已保存快照 · {value.name} v{value.version}</option>}{methods.map((method) => <option value={`${method.templateId}@${method.version}`} key={method.templateId}>{method.name} · v{method.version}</option>)}</select>{currentDefinition && <small>{currentDefinition.description}{currentDefinition.sourceAttribution ? ` · ${currentDefinition.sourceAttribution}` : ''}</small>}</label>;
}

function WorkflowNodeEditor({ node, nodes, partners, roles, methods, generationBasis, disabled, canMoveUp, canMoveDown, onChange, onMove, onRemove }: {
  node: ProjectWorkflowDraftNode;
  nodes: ProjectWorkflowDraftNode[];
  partners: Partner[];
  roles: ProjectWorkRoleDefinition[];
  methods: ProjectMethodTemplateDefinition[];
  generationBasis?: { summary?: string; sourceSeqs: number[] };
  disabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (update: (node: ProjectWorkflowDraftNode) => ProjectWorkflowDraftNode) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const execution = node.execution ?? { completionRule: { type: 'executor_submit' as const } };
  const completionRule = execution.completionRule ?? { type: 'executor_submit' as const };
  const updateExecution = (patch: Partial<NonNullable<ProjectWorkflowDraftNode['execution']>>) => onChange((current) => ({
    ...current,
    execution: { ...current.execution, completionRule: current.execution?.completionRule ?? { type: 'executor_submit' }, ...patch },
  }));
  return <article className="workflow-node">
    <header><span><b>{node.position + 1}</b><strong>{node.title || '未命名步骤'}</strong></span><div><button className="text-button" type="button" disabled={disabled || !canMoveUp} onClick={() => onMove(-1)} aria-label="上移步骤">↑</button><button className="text-button" type="button" disabled={disabled || !canMoveDown} onClick={() => onMove(1)} aria-label="下移步骤">↓</button><button className="text-button danger" type="button" disabled={disabled} onClick={onRemove}>删除</button></div></header>
    <div className="workflow-node__body">
      {generationBasis && <div className="workflow-node__basis"><strong>生成依据</strong><span>{generationBasis.summary || '规划伙伴未补充可见依据说明。'}</span><small>公开消息 {generationBasis.sourceSeqs.map((seq) => `#${seq}`).join('、')}</small></div>}
      <label className="modal-field">步骤名称<input value={node.title} disabled={disabled} maxLength={160} onChange={(event) => onChange((current) => ({ ...current, title: event.target.value }))} /></label>
      <label className="modal-field">步骤说明<textarea value={node.description} disabled={disabled} maxLength={20000} onChange={(event) => onChange((current) => ({ ...current, description: event.target.value }))} /></label>
      <label className="modal-field">负责人<select value={node.assigneeId ?? ''} disabled={disabled} onChange={(event) => onChange((current) => ({ ...current, assigneeId: event.target.value || undefined, execution: current.execution?.completionRule?.type === 'partner_review' && current.execution.completionRule.reviewerPartnerId === event.target.value ? { ...current.execution, completionRule: { ...current.execution.completionRule, reviewerPartnerId: '' } } : current.execution }))}><option value="">激活前必须选择</option>{partners.map((partner) => <option value={partner.id} key={partner.id}>{partner.publicIdentity.displayName}{partner.isRemoved ? '（已移除）' : ''}</option>)}</select></label>
      <WorkRoleSelect label="执行角色" value={execution.workRole} roles={roles} disabled={disabled} emptyLabel="默认任务执行者" onChange={(workRole) => updateExecution({ workRole })} />
      <WorkMethodSelect label="方法模板" value={execution.methodTemplate} methods={methods} disabled={disabled} emptyLabel="不使用方法模板" onChange={(methodTemplate) => updateExecution({ methodTemplate })} />
      <fieldset className="task-editor__dependencies"><legend>显式前置依赖</legend>{nodes.filter((candidate) => candidate.id !== node.id).map((candidate) => <label key={candidate.id}><input type="checkbox" disabled={disabled} checked={node.dependencyNodeIds.includes(candidate.id)} onChange={(event) => onChange((current) => ({ ...current, dependencyNodeIds: event.target.checked ? [...current.dependencyNodeIds, candidate.id] : current.dependencyNodeIds.filter((id) => id !== candidate.id) }))} /><span><strong>{candidate.position + 1}</strong>{candidate.title || '未命名步骤'}</span></label>)}{nodes.length <= 1 && <p>当前没有其他步骤可作为依赖。</p>}</fieldset>
      <label className="modal-field">验收标准 <small>每行一项</small><textarea value={node.acceptanceCriteria.join('\n')} disabled={disabled} onChange={(event) => onChange((current) => ({ ...current, acceptanceCriteria: event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) }))} /></label>
      <label className="modal-field">完成规则<select value={completionRule.type} disabled={disabled} onChange={(event) => {
        const type = event.target.value as ProjectTaskCompletionRule['type'];
        updateExecution({ completionRule: type === 'partner_review' ? { type, reviewerPartnerId: '', autoReworkLimit: 2 } : { type }, ...(type === 'partner_review' ? {} : { reviewWorkRole: undefined }) });
      }}><option value="executor_submit">执行者提交后自动完成</option><option value="partner_review">指定伙伴独立复核</option><option value="user_confirm">必须等待用户确认</option></select></label>
      {completionRule.type === 'partner_review' && <><div className="task-editor__row"><label className="modal-field">复核伙伴<select value={completionRule.reviewerPartnerId} disabled={disabled} onChange={(event) => updateExecution({ completionRule: { ...completionRule, reviewerPartnerId: event.target.value } })}><option value="">请选择复核伙伴</option>{partners.filter((partner) => partner.id !== node.assigneeId).map((partner) => <option value={partner.id} key={partner.id}>{partner.publicIdentity.displayName}</option>)}</select></label><label className="modal-field">自动返工上限<input type="number" min="0" max="10" value={completionRule.autoReworkLimit} disabled={disabled} onChange={(event) => updateExecution({ completionRule: { ...completionRule, autoReworkLimit: Math.max(0, Math.min(10, Number(event.target.value) || 0)) } })} /></label></div><WorkRoleSelect label="复核角色" value={execution.reviewWorkRole} roles={roles} disabled={disabled} emptyLabel="默认独立复核" hint="角色不能覆盖只检查、不修改的复核强制边界。" onChange={(reviewWorkRole) => updateExecution({ reviewWorkRole })} /></>}
      <label className="modal-field">步骤备注<textarea value={node.note} disabled={disabled} maxLength={20000} onChange={(event) => onChange((current) => ({ ...current, note: event.target.value }))} /></label>
    </div>
  </article>;
}

function Workspace({ runChanges, onViewChanges, tasks, allTasks, partners, attempts, workspaceReady, busyTaskId, error, filter, setFilter, onCreate, onManageRoles, onManageWorkflows, onEdit, onControl, onResolve, scrollTargetId, onScrollTargetHandled }: {
  runChanges: ProjectRunChange[];
  onViewChanges: (change: ProjectRunChange) => void;
  tasks: TaskItem[];
  allTasks: TaskItem[];
  partners: Partner[];
  attempts: TaskAttempt[];
  workspaceReady: boolean;
  busyTaskId?: string;
  error: string;
  filter: TaskFilter;
  setFilter: (value: TaskFilter) => void;
  onCreate: () => void;
  onManageRoles: () => void;
  onManageWorkflows: () => void;
  onEdit: (task: TaskItem) => void;
  onControl: (task: TaskItem, action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry', attempt?: TaskAttempt, reason?: string) => void;
  onResolve: (task: TaskItem, action: 'accept' | 'request_changes', feedback?: string, affectedCriteria?: string[]) => void;
  scrollTargetId?: string;
  onScrollTargetHandled: () => void;
}) {
  const filters: ReadonlyArray<readonly [TaskFilter, string]> = [['all', '全部'], ...TASK_STATUS_OPTIONS];
  const timelineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollTargetId) return;
    const frame = requestAnimationFrame(() => {
      const target = [...(timelineRef.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? [])]
        .find((item) => item.dataset.taskId === scrollTargetId);
      if (!target) return;
      target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      onScrollTargetHandled();
    });
    return () => cancelAnimationFrame(frame);
  }, [onScrollTargetHandled, scrollTargetId, tasks]);
  return <section className="workspace-view">
    <header className="workspace-toolbar"><nav className="task-filters" aria-label="任务筛选">{filters.map(([value, label]) => <button className={filter === value ? 'active' : ''} type="button" key={value} onClick={() => setFilter(value)}>{label}</button>)}</nav><span className="workspace-toolbar__actions"><button className="secondary-button" type="button" onClick={onManageRoles}><Sparkles size={15} />角色管理</button><button className="secondary-button" type="button" onClick={onManageWorkflows}><FolderKanban size={15} />流程草稿</button><button className="primary-button workspace-task-create" type="button" onClick={onCreate}><Plus size={15} />新建任务</button></span></header>
    {error && <p className="workspace-execution-error">{error}</p>}
    <div className="task-timeline scroll-region" ref={timelineRef}>{tasks.length ? tasks.map((task) => {
      const owner = partners.find((partner) => partner.id === task.assigneeId);
      const dependencies = task.dependencyIds.map((id) => allTasks.find((candidate) => candidate.id === id)).filter((item): item is TaskItem => Boolean(item));
      const taskAttempts = attempts.filter((candidate) => candidate.taskId === task.id).sort((left, right) => left.attemptNumber - right.attemptNumber);
      const attempt = taskAttempts.at(-1);
      const stageVoices = taskStageVoiceItems(taskAttempts, (partnerId) => partners.find((partner) => partner.id === partnerId)?.publicIdentity.displayName ?? '伙伴');
      const busy = busyTaskId === task.id;
      const failure = attempt ? taskAttemptFailureLabel(attempt) : '';
      const canStart = Boolean(task.assigneeId) && workspaceReady && (
        (!attempt && task.status !== 'completed' && task.status !== 'cancelled')
        || (attempt?.status === 'succeeded' && task.status === 'todo')
      );
      return <article className="timeline-entry" data-task-id={task.id} key={task.id}>
        <Avatar partnerId={owner?.id} name={owner?.publicIdentity.displayName ?? '未分配'} src={owner?.publicIdentity.avatarDataUrl} accent={owner?.accent ?? '#7897c9'} size="md" />
        <span className="timeline-line" aria-hidden="true" />
        <div className="timeline-content">
          <header><strong>{owner?.publicIdentity.displayName ?? '暂未分配'}{owner?.isRemoved ? '（已移除）' : ''}</strong><time title={task.updatedAt}>{formatTaskTime(task.updatedAt)}</time></header>
          {task.note && <p>{task.note}</p>}
          <span className={`status-chip status-chip--${task.status}`}>{projectTaskStatusLabel(task)}</span>
          {attempt && <span className="task-run-state">{attemptStatusLabel(attempt)} · 第 {attempt.attemptNumber} 次</span>}
          {failure && <p className="task-run-failure" role="alert">失败原因：{failure}</p>}
          <div className="task-card">
            <header><span className="task-code"><ShieldCheck size={18} />{task.code}</span><strong>{task.title}</strong><button className="icon-button" type="button" onClick={() => onEdit(task)} aria-label={`编辑任务 ${task.title}`}><Pencil size={15} /></button></header>
            <div className="task-card__columns">
              <section className="task-card__body" aria-label="任务节点">
                {task.description && <p>{task.description}</p>}
                <div className="task-people"><span>负责人 <b>{owner ? <><Avatar partnerId={owner.id} name={owner.publicIdentity.displayName} src={owner.publicIdentity.avatarDataUrl} accent={owner.accent} size="sm" />{owner.publicIdentity.displayName}</> : '暂未分配'}</b></span><span>角色 <b>{task.execution?.workRole?.name ?? '默认执行者'}</b></span><span>依赖 <b>{dependencies.length ? dependencies.map((dependency) => dependency.code).join('、') : '无'}</b></span><span>验收标准 <b>{task.acceptanceCriteria.length ? `${task.acceptanceCriteria.length} 项` : '未填写'}</b></span></div>
                {task.acceptanceCriteria.length > 0 && <ul className="task-criteria">{task.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>}
              </section>
              <aside className="task-stage-voices" aria-label="各阶段伙伴发言"><header>阶段发言</header>{stageVoices.length ? stageVoices.map((voice) => <div key={voice.id}><p><strong>{voice.label}：</strong>{voice.summary}</p>{(() => { const source = taskAttempts.find((item) => voice.id === `${item.id}:handoff`); return source && source.status === 'succeeded' ? <RunChangeSummary change={runChanges.find((record) => record.attemptId === source.id)} missing onView={onViewChanges} /> : null; })()}</div>) : <small>任务运行后，这里会按阶段显示伙伴提交的摘要。</small>}</aside>
            </div>
            <TaskExecutionControls key={attempt?.id ?? 'not-started'} task={task} attempt={attempt} busy={busy} canStart={canStart} workspaceReady={workspaceReady} onControl={onControl} onResolve={onResolve} />
          </div>
        </div>
      </article>;
    }) : <div className="friendly-empty"><CheckCircle2 size={34} /><h2>这个筛选下还没有任务</h2><p>{filter === 'all' ? '创建第一项任务，把项目拆成可验收的工作。' : '切换筛选查看其他任务，或新建一项任务。'}</p><button className="primary-button" type="button" onClick={onCreate}><Plus size={15} />新建任务</button></div>}</div>
  </section>;
}

function TaskExecutionControls({ task, attempt, busy, canStart, workspaceReady, onControl, onResolve }: {
  task: TaskItem;
  attempt?: TaskAttempt;
  busy: boolean;
  canStart: boolean;
  workspaceReady: boolean;
  onControl: (task: TaskItem, action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry', attempt?: TaskAttempt, reason?: string) => void;
  onResolve: (task: TaskItem, action: 'accept' | 'request_changes', feedback?: string, affectedCriteria?: string[]) => void;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [affectedCriteria, setAffectedCriteria] = useState<string[]>(() => attempt?.review?.criteria.filter((item) => item.verdict !== 'pass').map((item) => item.criterionId) ?? []);
  const buttons: Array<{ action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry'; label: string; icon: typeof Play }> = [];
  if (attempt && ['failed', 'cancelled'].includes(attempt.status)) buttons.push({ action: 'retry', label: '重试', icon: RotateCcw });
  else if (canStart) buttons.push({ action: 'start', label: '执行任务', icon: Play });
  else if (attempt?.status === 'paused' && !attempt.handoff?.userDecisionRequest && !attempt.review?.userDecisionRequest) buttons.push({ action: 'resume', label: '继续', icon: Play }, { action: 'cancel', label: '取消', icon: Square });
  else if (attempt && ['waiting_dependencies', 'queued', 'starting', 'running', 'pause_requested'].includes(attempt.status)) {
    if (!['pause_requested'].includes(attempt.status)) buttons.push({ action: 'pause', label: '暂停', icon: Pause });
    buttons.push({ action: 'cancel', label: '取消', icon: Square });
  }
  const unavailable = !task.assigneeId ? '请先分配负责人' : !workspaceReady ? '请先建立项目目录' : '';
  const question = attempt?.handoff?.userDecisionRequest ?? attempt?.review?.userDecisionRequest;
  const pendingGate = task.status === 'review' && attempt?.status === 'succeeded' && (
    task.execution?.completionRule?.type === 'user_confirm'
    || attempt.purpose === 'review' && attempt.review?.decision === 'changes_required'
    || attempt.completionFlowVersion === 1
    || !task.execution?.completionRule
  );
  if (!buttons.length && !unavailable && !question && !pendingGate) return null;
  return <footer className="task-execution-controls task-execution-controls--gate">
    {unavailable ? <small>{unavailable}</small> : <>
      {question && <div className="task-gate"><strong>需要你的决定</strong><p>{question.question}</p><small>{question.reason}</small><textarea value={feedback} disabled={busy} onChange={(event) => setFeedback(event.target.value)} placeholder="填写回答后继续当前阶段" /><span><button className="secondary-button" type="button" disabled={busy} onClick={() => onControl(task, 'cancel', attempt)}>取消任务</button><button className="primary-button" type="button" disabled={busy || !feedback.trim()} onClick={() => onControl(task, 'resume', attempt, `用户回答：${feedback.trim()}`)}>回答并继续</button></span></div>}
      {pendingGate && <div className="task-gate"><strong>{attempt?.purpose === 'review' ? '复核未通过，等待处理' : '提交已完成，等待你的确认'}</strong>{feedbackOpen && <><textarea value={feedback} disabled={busy} onChange={(event) => setFeedback(event.target.value)} placeholder="只填写既有验收项需要调整的内容" />{task.acceptanceCriteria.length > 0 && <fieldset className="task-gate__criteria"><legend>选择未通过的验收项</legend>{task.acceptanceCriteria.map((criterion, index) => { const criterionId = `r${attempt?.taskRevision}:c${index + 1}`; return <label key={criterionId}><input type="checkbox" checked={affectedCriteria.includes(criterionId)} disabled={busy} onChange={(event) => setAffectedCriteria((current) => event.target.checked ? [...current, criterionId] : current.filter((item) => item !== criterionId))} />{criterion}</label>; })}</fieldset>}</>}<span><button className="secondary-button" type="button" disabled={busy || (feedbackOpen && (!feedback.trim() || task.acceptanceCriteria.length > 0 && !affectedCriteria.length))} onClick={() => { if (!feedbackOpen) setFeedbackOpen(true); else onResolve(task, 'request_changes', feedback, affectedCriteria); }}>{feedbackOpen ? '提交调整要求' : '要求调整'}</button><button className="primary-button" type="button" disabled={busy} onClick={() => onResolve(task, 'accept')}>确认完成</button></span></div>}
      {!question && !pendingGate && buttons.map(({ action, label, icon: Icon }) => <button className={action === 'cancel' ? 'secondary-button' : 'primary-button'} type="button" disabled={busy} key={action} onClick={() => onControl(task, action, attempt)}>{busy ? <Loader2 className="spin" size={13} /> : <Icon size={13} />}{label}</button>)}
    </>}
  </footer>;
}

function NewGroupModal(props: {
  state: ReturnType<typeof usePrototype>['state'];
  projectChoice: 'existing' | 'new';
  setProjectChoice: (value: 'existing' | 'new') => void;
  selectedProjectId: string;
  setSelectedProjectId: (value: string) => void;
  newProjectName: string;
  setNewProjectName: (value: string) => void;
  newProjectDescription: string;
  setNewProjectDescription: (value: string) => void;
  projectLocation: ProjectLocationSelection | null;
  setProjectLocation: (value: ProjectLocationSelection | null) => void;
  chooseProjectLocation: () => void;
  newGroupName: string;
  setNewGroupName: (value: string) => void;
  error: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const [defaultProjectRoot, setDefaultProjectRoot] = useState('');
  useEffect(() => {
    let active = true;
    void window.asteriumStorage?.get().then(value => { if (active) setDefaultProjectRoot(value.defaultProjectRoot); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return <Modal size="md" title="新建工作室群聊" description="每个群聊归属一个项目；新项目会同时建立真实文件夹与基础资料。" onClose={props.onClose}>
    <div className="modal-body">
      <nav className="project-choice-tabs" aria-label="项目来源"><button className={props.projectChoice === 'new' ? 'active' : ''} type="button" disabled={props.busy} onClick={() => props.setProjectChoice('new')}>创建新项目</button><button className={props.projectChoice === 'existing' ? 'active' : ''} type="button" disabled={props.busy} onClick={() => props.setProjectChoice('existing')}>选择已有项目</button></nav>
      {props.projectChoice === 'existing' ? <div className="project-choice-list" role="radiogroup" aria-label="选择项目">{props.state.projects.map((item, index) => { const Icon = projectIcons[index] ?? FolderKanban; return <button className={props.selectedProjectId === item.id ? 'active' : ''} type="button" role="radio" aria-checked={props.selectedProjectId === item.id} key={item.id} disabled={props.busy} onClick={() => props.setSelectedProjectId(item.id)}><span><Icon size={19} /></span><span><strong>{item.name}</strong><small>{item.workspace?.status === 'ready' ? '真实项目文件夹已建立' : item.description}</small></span>{props.selectedProjectId === item.id && <i className="choice-dot" />}</button>; })}</div> : <div className="new-project-fields">
        <label className="modal-field">项目名称<input value={props.newProjectName} disabled={props.busy} onChange={(event) => props.setNewProjectName(event.target.value)} placeholder="例如：秋季示例项目 B" maxLength={50} /></label>
        <label className="modal-field">项目背景 <small>会写入项目方案的“背景”章节</small><textarea value={props.newProjectDescription} disabled={props.busy} onChange={(event) => props.setNewProjectDescription(event.target.value)} placeholder="简单写下为什么要做这个项目，也可以稍后补充。" maxLength={1000} /></label>
        <section className="project-location-choice"><span className="project-location-choice__icon"><MapPin size={18} /></span><span><small>{props.projectLocation ? '使用指定文件夹' : '自动创建项目文件夹'}</small><strong title={props.projectLocation?.path}>{props.projectLocation?.path ?? (defaultProjectRoot || '创建前将显示最终保存位置')}</strong><em>会生成 3 份基础 MD，项目上传资料将存入 uploads</em></span><div>{props.projectLocation && <button className="text-button" type="button" disabled={props.busy} onClick={() => props.setProjectLocation(null)}>恢复默认</button>}<button className="secondary-button" type="button" disabled={props.busy || !window.asteriumProjects} onClick={props.chooseProjectLocation}><FolderOpen size={14} />选择文件夹</button></div></section>
      </div>}
      <label className="modal-field">群聊名称<input value={props.newGroupName} disabled={props.busy} onChange={(event) => props.setNewGroupName(event.target.value)} placeholder="例如：方案讨论组" maxLength={50} /></label>
      {props.error && <p className="modal-error">{props.error}</p>}
    </div>
    <footer className="modal-footer"><button className="secondary-button" type="button" disabled={props.busy} onClick={props.onClose}>取消</button><button className="primary-button" type="button" disabled={props.busy} onClick={props.onSubmit}>{props.busy ? <><Loader2 className="spin" size={16} />正在创建项目…</> : '创建并进入'}</button></footer>
  </Modal>;
}

function attemptStatusLabel(attempt: TaskAttempt) {
  const status = {
    waiting_dependencies: '等待前置任务', queued: '等待执行', starting: '正在启动', running: '执行中', pause_requested: '正在暂停', paused: '已暂停',
    cancel_requested: '正在取消', cancelled: '已取消', failed: '执行失败', succeeded: '已提交',
  }[attempt.status];
  if (attempt.purpose === 'review') return attempt.status === 'succeeded' ? '复核已提交' : status.replace('执行', '复核');
  if (attempt.purpose === 'rework') return attempt.status === 'succeeded' ? `第 ${attempt.reworkRound} 轮返工已提交` : `${status.replace('执行', '返工')} · 第 ${attempt.reworkRound} 轮`;
  return status;
}

function formatTaskTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '刚刚';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(parsed);
}

function projectTaskError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('PROJECT_TASK_DEPENDENCY_CYCLE')) return '任务依赖不能形成循环。';
  if (message.includes('PROJECT_TASK_DEPENDENCY_INVALID')) return '依赖任务已经变化，请重新选择。';
  if (message.includes('PROJECT_TASK_ASSIGNEE_NOT_MEMBER')) return '负责人必须是当前项目成员。';
  if (message.includes('PROJECT_TASK_REVIEWER_NOT_MEMBER')) return '复核伙伴必须是当前项目成员。';
  if (message.includes('PROJECT_TASK_REVIEWER_MUST_BE_INDEPENDENT')) return '独立复核必须选择不同于负责人的伙伴。';
  if (message.includes('PROJECT_TASK_REVIEW_CRITERIA_REQUIRED')) return '配置独立复核前，请至少填写一项验收标准。';
  if (message.includes('PROJECT_WORK_ROLE_SNAPSHOT_STALE')) return '所选角色已经更新，请重新选择最新版本。';
  if (message.includes('PROJECT_WORK_ROLE_NOT_SELECTABLE')) return '所选角色已归档、删除或不属于当前项目，请重新选择。';
  if (message.includes('PROJECT_METHOD_TEMPLATE_SNAPSHOT_STALE')) return '所选方法模板已经更新，请重新选择。';
  if (message.includes('PROJECT_METHOD_TEMPLATE_NOT_SELECTABLE')) return '所选方法模板已不可用，请重新选择。';
  if (message.includes('PROJECT_TASK_HAS_DEPENDENTS')) return '仍有其他任务依赖它，请先调整依赖关系。';
  if (message.includes('PROJECT_TASK_BELONGS_TO_ACTIVE_WORKFLOW')) return '这个任务属于正在运行的流程，不能单独删除；请先让流程完成或取消任务执行。';
  if (message.includes('REVISION_CONFLICT')) return '任务已在其他窗口更新，请关闭后重新打开。';
  return '任务没有保存成功，请稍后重试。';
}

function projectRoleError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('REVISION_CONFLICT')) return '角色已在其他窗口更新，请重新打开后再试。';
  if (message.includes('RESPONSIBILITIES_REQUIRED')) return '请至少填写一项角色职责。';
  if (message.includes('NAME_INVALID')) return '请填写角色名称。';
  if (message.includes('NOT_FOUND')) return '角色已经被删除。';
  return '角色没有保存成功，请稍后重试。';
}

function projectWorkflowError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('PROJECT_WORKFLOW_DEPENDENCY_CYCLE')) return '步骤依赖不能形成循环。';
  if (message.includes('PROJECT_WORKFLOW_DEPENDENCY_INVALID')) return '步骤依赖已经变化，请重新选择。';
  if (message.includes('PROJECT_WORKFLOW_EMPTY')) return '请至少增加一个步骤后再确认执行。';
  if (message.includes('PROJECT_WORKFLOW_ASSIGNEE_REQUIRED')) return '确认执行前，请为每个步骤选择负责人。';
  if (message.includes('PROJECT_HAS_ACTIVE_TASK_ATTEMPTS')) return '项目仍有正在执行的任务，请等待或停止后再激活新流程。';
  if (message.includes('PROJECT_WORKSPACE_NOT_READY')) return '请先建立可用的项目文件夹。';
  if (message.includes('PROJECT_TASK_REVIEWER_MUST_BE_INDEPENDENT')) return '独立复核必须选择不同于负责人的伙伴。';
  if (message.includes('PROJECT_TASK_REVIEW_CRITERIA_REQUIRED')) return '配置独立复核前，请至少填写一项验收标准。';
  if (message.includes('PROJECT_WORK_ROLE_SNAPSHOT_STALE')) return '所选角色已经更新，请重新选择最新版本。';
  if (message.includes('PROJECT_WORK_ROLE_NOT_SELECTABLE')) return '所选角色已归档、删除或不属于当前项目，请重新选择。';
  if (message.includes('PROJECT_METHOD_TEMPLATE_SNAPSHOT_STALE')) return '所选方法模板已经更新，请重新选择。';
  if (message.includes('PROJECT_METHOD_TEMPLATE_NOT_SELECTABLE')) return '所选方法模板已不可用，请重新选择。';
  if (message.includes('PROJECT_WORKFLOW_ACTIVE')) return '正在激活或执行的流程不能移除。';
  if (message.includes('REVISION_CONFLICT')) return '流程草稿已在其他窗口更新，请重新打开后再试。';
  if (message.includes('NOT_FOUND')) return '流程草稿或模板已经不存在。';
  return '流程没有保存或激活成功，请检查步骤、负责人、依赖和项目目录。';
}

function workflowGenerationStatusLabel(status: ProjectWorkflowGeneration['status']) {
  if (status === 'running') return '正在生成工作流草稿';
  if (status === 'submitted') return '草稿已保存';
  if (status === 'cancelled') return '生成已取消';
  if (status === 'interrupted') return '生成因重启中断';
  return '生成失败';
}

function workflowGenerationErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const friendly = friendlyRuntimeErrorMessage(message);
  if (friendly !== message) return friendly;
  if (message.includes('SOURCE_REQUIRED')) return '请至少选择一条公开消息。';
  if (message.includes('SOURCE_DUPLICATE') || message.includes('SOURCE_INVALID')) return '所选消息已变化，请关闭后重新选择。';
  if (message.includes('SOURCE_LIMIT')) return '最多选择 160 条消息，且总内容不能超过 80,000 字符。';
  if (message.includes('PLANNER_NOT_MEMBER')) return '规划伙伴必须同时是当前项目和当前群聊成员。';
  if (message.includes('PLANNER_UNAVAILABLE')) return '所选规划伙伴当前没有可用 Runtime。';
  if (message.includes('ROOM_BUSY')) return '请等当前群聊轮次结束后再生成。';
  if (message.includes('IDEMPOTENCY_CONFLICT')) return '这次生成请求与已有请求冲突，请重新发起。';
  if (message.includes('ALREADY_RUNNING')) return '当前群聊已有一次工作流生成正在运行。';
  if (message.includes('NOT_RETRYABLE')) return '当前生成记录不能重试。';
  return '工作流草稿生成失败，请检查规划伙伴状态后重试。';
}

function mergeWorkflowGenerations(current: ProjectWorkflowGeneration[], incoming: ProjectWorkflowGeneration[]) {
  const merged = new Map(current.map((generation) => [generation.id, generation]));
  for (const generation of incoming) {
    const previous = merged.get(generation.id);
    if (!previous || generation.updatedAt >= previous.updatedAt) merged.set(generation.id, generation);
  }
  return [...merged.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function workflowStatusLabel(workflow: ProjectWorkflow) {
  if (workflow.status === 'activating') return '正在激活';
  if (workflow.status === 'active') return '执行中';
  if (workflow.status === 'completed') return '已完成';
  if (workflow.status === 'cancelled' && workflow.cancellationReason === 'referenced_task_missing') return '已终止（关联任务已移除）';
  if (workflow.status === 'cancelled' && workflow.cancellationReason === 'task_cancelled') return '已终止（任务已取消）';
  if (workflow.status === 'cancelled') return '已终止';
  return '草稿';
}

function taskExecutionMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const friendly = friendlyRuntimeErrorMessage(message);
  if (friendly !== message) return friendly;
  if (message.includes('PROJECT_TASK_ASSIGNEE_REQUIRED')) return '请先为任务分配负责人。';
  if (message.includes('PROJECT_WORKSPACE_NOT_READY')) return '请先建立可用的项目目录。';
  if (message.includes('PROJECT_TASK_PARTNER_RUNTIME_UNAVAILABLE')) return '当前负责人没有可用的 Codex、Claude 或 API Runtime。';
  if (message.includes('TASK_REWORK_FEEDBACK_REQUIRED')) return '请填写明确的调整要求。';
  if (message.includes('TASK_REWORK_CRITERIA_REQUIRED')) return '请选择至少一项未通过的验收标准。';
  if (message.includes('TASK_GATE_NOT_WAITING')) return '当前任务已经不在等待确认状态，请刷新后再试。';
  if (message.includes('TASK_ATTEMPT_NOT_')) return '任务状态已经变化，请稍后再试。';
  if (message.includes('PROJECT_TASK_RUNTIME_NOT_CONNECTED')) return '伙伴运行环境尚未就绪。';
  return '任务执行操作失败，请检查负责人、项目目录和运行环境。';
}

function speakingModeLabel(mode: StudioRoomSettings['speakingMode']) {
  return { free_discussion: '自由讨论', selected_partners: '指定发言', round_robin: '逐一回应' }[mode];
}

function matchesProjectFilePath(file: Project['files'][number], path: string) {
  return file.relativePath?.replaceAll('\\', '/') === path.replaceAll('\\', '/');
}

function nextGroupChatName(existingNames: string[]) {
  const names = new Set(existingNames);
  if (!names.has('新群聊')) return '新群聊';
  let index = 2;
  while (names.has(`新群聊 ${index}`)) index += 1;
  return `新群聊 ${index}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readRailWidth(key: string, fallback: number, min: number, max: number) {
  const stored = Number(window.localStorage.getItem(key));
  return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : fallback;
}

function projectWorkspaceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('PROJECT_DIRECTORY_ALREADY_USED')) return '这个文件夹已经属于另一个项目，请换一个目录。';
  if (message.includes('PROJECT_CREATE_LOCATION_CHANGED')) return '项目保存位置已变化，请重新确认。';
  if (message.includes('PROJECT_LOCATION_SELECTION_EXPIRED')) return '目录选择已失效，请重新选择。';
  if (message.includes('PROJECT_DIRECTORY')) return '无法建立项目文件夹，请检查目录权限或换一个位置。';
  if (message.includes('PROJECT_NAME_INVALID')) return '项目名称不能为空或过长。';
  return message || '项目创建失败，请稍后重试。';
}
