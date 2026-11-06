import { Check, ChevronDown, ChevronRight, FolderPlus, LoaderCircle, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { WorkspaceGrant } from '../../../shared/agentProtocol';
import { defaultApiModelImages } from '../../../shared/apiConnections';
import type { Conversation, Partner, Project } from '../../types/domain';
import { Avatar } from './Avatar';

interface PartnerQuickCardProps {
  partner?: Partner;
  conversation?: Conversation;
  projects?: Project[];
  codexModelPicker?: ReactNode;
  onUpdatePartner: (partner: Partner) => void | Promise<void>;
  onUpdateWorkspaceGrants: (partnerId: string, grants: WorkspaceGrant[], preferredGrantId?: string) => void;
}

export function PartnerQuickCard({ partner, conversation, projects = [], codexModelPicker, onUpdatePartner, onUpdateWorkspaceGrants }: PartnerQuickCardProps) {
  const [open, setOpen] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const modelSavePending = useRef(false);
  const [notice, setNotice] = useState('');
  const [expandedDirectories, setExpandedDirectories] = useState({ subdirectories: false, projects: false });

  if (!partner) return null;

  const apiWorkspaceIndex = partner.sourceMode === 'api_partner'
    ? Math.max(0, partner.workspaceGrantIds?.indexOf(partner.primaryWorkspaceGrantId ?? '') ?? -1)
    : 0;
  const apiWorkspace = partner.sourceMode === 'api_partner'
    ? partner.workingDirectories?.[apiWorkspaceIndex] ?? partner.workingDirectories?.[0]
    : undefined;
  const source = partner.sourceMode === 'existing_thread'
    ? 'CyberBoss · 现有线程'
    : partner.sourceMode === 'local_cli'
      ? partner.adapterType === 'codex_cli' ? '本地 Codex CLI' : '本地 Claude Code'
      : `${partner.provider} · API`;

  const loadModels = async () => {
    if (partner.sourceMode !== 'api_partner' || models.length || modelsBusy) return;
    if (!partner.credentialRef || !window.asteriumAgents?.listApiModels) return setNotice('请先在伙伴管理中配置模型连接');
    setModelsBusy(true);
    setNotice('');
    try {
      const available = await window.asteriumAgents.listApiModels(partner.provider, partner.endpoint ?? '', partner.credentialRef);
      setModels(available.map((model) => model.id));
    } catch {
      setNotice('暂时无法读取模型列表');
    } finally {
      setModelsBusy(false);
    }
  };

  const saveModel = async (model: string) => {
    if (partner.sourceMode !== 'api_partner' || modelSavePending.current) return;
    modelSavePending.current = true; setModelSaving(true); setNotice('');
    try {
      const bridge = window.asteriumAgents;
      const config = await bridge?.apiConnectionsGet?.();
      const binding = config?.bindings.find(b => b.partnerId === partner.id);
      const profile = config?.models.find(m => m.id === binding?.modelId);
      let modelId = partner.modelId;
      if (config && binding && profile && bridge?.apiConnectionsMutate) {
        const service = config.services.find(item => item.id === profile.serviceId);
        if (!service) throw new Error('API_CONFIGURATION_INVALID_BINDING');
        const saved = config.models.find(item => item.serviceId === service.id && item.model === model);
        const nextModel = { ...profile, id: crypto.randomUUID(), model, name: model, tools: profile.tools, images: saved?.images ?? defaultApiModelImages(service) };
        const next = await bridge.apiConnectionsMutate({ action: 'model', expectedRevision: config.revision, value: nextModel });
        await bridge.apiConnectionsMutate({ action: 'bind', expectedRevision: next.revision, partnerId: partner.id, modelId: nextModel.id });
        modelId = nextModel.id;
      }
      await onUpdatePartner({ ...partner, model, ...(modelId ? { modelId } : {}) });
      setNotice('模型已保存，将用于下一轮。');
    } catch (error) {
      setNotice(error instanceof Error && error.message.includes('PROFILE_VERSION_CONFLICT')
        ? '伙伴资料已变化，模型未切换。请刷新资料后重试。'
        : '模型保存失败，仍使用原选择。请重试。');
    } finally { modelSavePending.current = false; setModelSaving(false); }
  };

  const addWorkspace = async () => {
    if (partner.sourceMode === 'existing_thread') return;
    if (!window.asteriumAgents?.selectWorkspace) return setNotice('仅桌面应用支持目录授权');
    setNotice('');
    try {
      const selected = await window.asteriumAgents.selectWorkspace('workspace');
      if (!selected) return;
      const ids = partner.workspaceGrantIds ?? [];
      const directories = partner.workingDirectories
        ?? (partner.sourceMode === 'local_cli' && partner.workingDirectory ? [partner.workingDirectory] : []);
      const current = ids
        .map((grantId, index) => ({ grantId, displayPath: directories[index] }))
        .filter((grant): grant is WorkspaceGrant => Boolean(grant.displayPath));
      const grants = current.some((grant) => grant.displayPath === selected.displayPath) ? current : [...current, selected];
      const preferredGrantId = partner.sourceMode === 'local_cli'
        ? partner.activeWorkspaceGrantId || selected.grantId
        : partner.primaryWorkspaceGrantId || selected.grantId;
      onUpdateWorkspaceGrants(partner.id, grants, preferredGrantId);
      setNotice(partner.sourceMode === 'local_cli'
        ? '子目录已添加；伙伴配置来源不变，该伙伴所有对话都会共享此目录'
        : '子目录已添加；API 伙伴主工作目录保持不变');
    } catch {
      setNotice('工作区授权没有完成');
    }
  };

  const workspaceGrants = partner.sourceMode !== 'existing_thread'
    ? (partner.workspaceGrantIds ?? []).map((grantId, index) => ({ grantId, displayPath: partner.workingDirectories?.[index] ?? '' })).filter((grant): grant is WorkspaceGrant => Boolean(grant.displayPath))
    : [];
  const projectWorkspaces = projects.filter((project) => project.workspace?.status === 'ready' && project.workspace.rootPath);
  const projectPaths = new Set(projectWorkspaces.map((project) => normalizePath(project.workspace!.rootPath!)));

  const switchWorkspace = (grantId: string) => {
    if (partner.sourceMode !== 'local_cli') return;
    onUpdateWorkspaceGrants(partner.id, workspaceGrants, grantId);
    setNotice('已更新伙伴工作区显示；所有对话共享同一套授权，CWD 仍由伙伴配置来源决定');
  };

  const removeWorkspace = async (grantId: string) => {
    if (partner.sourceMode !== 'local_cli') return;
    try {
      const next = workspaceGrants.filter((grant) => grant.grantId !== grantId);
      onUpdateWorkspaceGrants(partner.id, next, partner.activeWorkspaceGrantId === grantId ? next[0]?.grantId : partner.activeWorkspaceGrantId);
      setNotice('已从伙伴工作区移除；该伙伴所有对话都会使用更新后的工作区');
    } catch {
      setNotice('工作区授权移除失败');
    }
  };
  const subdirectories: DirectoryEntry[] = partner.sourceMode === 'local_cli'
    ? workspaceGrants.filter((grant) => !projectPaths.has(normalizePath(grant.displayPath))).map((grant) => ({
      id: grant.grantId,
      path: grant.displayPath,
      active: grant.grantId === partner.activeWorkspaceGrantId,
      onSelect: () => switchWorkspace(grant.grantId),
      onRemove: () => void removeWorkspace(grant.grantId),
    }))
    : partner.sourceMode === 'api_partner'
      ? (partner.workspaceGrantIds ?? []).map((grantId, index) => ({ grantId, path: partner.workingDirectories?.[index] ?? '', index }))
        .filter((grant) => grant.path && grant.index !== apiWorkspaceIndex && !projectPaths.has(normalizePath(grant.path)))
        .map((grant) => ({ id: grant.grantId, path: grant.path }))
      : [];
  const projectDirectories: DirectoryEntry[] = projectWorkspaces.map((project) => ({ id: project.id, path: project.workspace!.rootPath!, context: project.name }));
  const conversationModel = conversation?.partnerId === partner.id ? conversation.runtimeModel : undefined;
  const currentModel = conversationModel?.status === 'current' ? conversationModel : undefined;
  const observedModel = currentModel ?? conversationModel ?? partner.recentModel;

  return (
    <section className={`partner-quick-card ${open ? 'open' : ''}`}>
      <button className="partner-quick-card__toggle" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <Avatar partnerId={partner.id} name={partner.publicIdentity.displayName} src={partner.publicIdentity.avatarDataUrl} accent={partner.accent} size="sm" source={partner.sourceMode} />
        <span><strong>{partner.publicIdentity.displayName}</strong><small>{source}</small></span>
        <ChevronDown size={17} />
      </button>
      {open && (
        <div className="partner-quick-card__body">
          <div className="quick-detail">
            <span>当前状态</span>
            <strong><i className={`status-dot status-dot--${partner.status}`} />{statusLabel(partner.status)}</strong>
          </div>
          {partner.sourceMode === 'local_cli' ? <>
            <div className="quick-detail">
              <span>伙伴配置来源</span>
              <strong title={partner.partnerRoot}>{partner.partnerRoot || '旧版星丛私有目录（请重新选择）'}</strong>
              <small>仅可在伙伴设置中修改</small>
            </div>
            <div className="quick-detail">
              <span>MCP</span>
              <strong>跟随 {partner.adapterType === 'claude_code' ? 'Claude Code' : 'Codex'} 会话</strong>
              <small>以伙伴配置来源中的实际连接状态为准</small>
            </div>
          </> : <div className="quick-detail">
            <span>{partner.sourceMode === 'api_partner' ? '伙伴配置来源' : '伙伴工作区'}</span>
            <strong title={partner.sourceMode === 'api_partner' ? apiWorkspace : partner.workspaceRoot}>{partner.sourceMode === 'api_partner' ? apiWorkspace || '空' : partner.workspaceRoot || '空'}</strong>
            {partner.sourceMode === 'api_partner' && <small>Agent 主工作目录，仅可在伙伴设置中修改</small>}
          </div>}
          <DirectorySection label="子目录" entries={subdirectories} expanded={expandedDirectories.subdirectories} onToggle={() => setExpandedDirectories((current) => ({ ...current, subdirectories: !current.subdirectories }))} />
          {partner.sourceMode !== 'existing_thread' && <button className="quick-action quick-directory-add" type="button" onClick={addWorkspace}><FolderPlus size={14} />添加子目录</button>}
          <DirectorySection label="项目目录" entries={projectDirectories} expanded={expandedDirectories.projects} onToggle={() => setExpandedDirectories((current) => ({ ...current, projects: !current.projects }))} />
          <div className="quick-detail quick-detail--model">
            <span>{currentModel ? '当前模型' : observedModel ? '最近模型' : '模型'}</span>
            <strong>{observedModel?.model ?? '尚未报告'}</strong>
            {observedModel && <small>{currentModel ? '绑定当前对话与原生线程' : '来自最近一次 Runtime 观测'}</small>}
          </div>
          {partner.sourceMode === 'api_partner' ? <label className="quick-detail quick-detail--model">
            <span>选择模型</span>
            <span className="quick-model-select">
              <select aria-label="选择 API 模型" value={partner.model} disabled={modelSaving} onFocus={() => void loadModels()} onChange={(event) => void saveModel(event.target.value)}>
                {[partner.model, ...models.filter((model) => model !== partner.model)].map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
              {modelsBusy && <LoaderCircle className="spin" size={14} />}
            </span>
            <small>选择会用于下一轮；上方继续显示当前对话实际报告的模型。</small>
          </label> : codexModelPicker}
          {notice && <small className="quick-card-notice">{notice}</small>}
        </div>
      )}
    </section>
  );
}

interface DirectoryEntry {
  id: string;
  path: string;
  context?: string;
  active?: boolean;
  onSelect?: () => void;
  onRemove?: () => void;
}

function DirectorySection({ label, entries, expanded, onToggle }: { label: string; entries: DirectoryEntry[]; expanded: boolean; onToggle: () => void }) {
  const visible = expanded ? entries : entries.slice(-1);
  return <div className="quick-detail quick-directory-section">
    <span className="quick-directory-section__heading"><span>{label}</span>{entries.length > 1 && <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}全部${label}`}><small>{expanded ? '收起' : `全部 ${entries.length}`}</small>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}</span>
    {visible.length ? <div className="quick-directory-list">{visible.map((entry) => <div className={entry.active ? 'quick-directory-row active' : 'quick-directory-row'} key={entry.id}>
      {entry.onSelect ? <button className="quick-directory-main" type="button" title={entry.path} onClick={entry.onSelect}><span>{entry.context && <small>{entry.context}</small>}<strong>{abbreviatePath(entry.path)}</strong></span>{entry.active && <Check size={13} />}</button>
        : <span className="quick-directory-main" title={entry.path}><span>{entry.context && <small>{entry.context}</small>}<strong>{abbreviatePath(entry.path)}</strong></span></span>}
      {entry.onRemove && <button className="quick-directory-remove" type="button" aria-label={`移除子目录 ${entry.path}`} onClick={entry.onRemove}><Trash2 size={13} /></button>}
    </div>)}</div> : <strong className="quick-directory-empty">空</strong>}
  </div>;
}

function abbreviatePath(value: string, limit = 48) {
  if (value.length <= limit) return value;
  const edge = Math.floor((limit - 1) / 2);
  return `${value.slice(0, edge)}…${value.slice(-edge)}`;
}

function normalizePath(value: string) {
  return value.replace(/[\\/]+$/, '').toLocaleLowerCase();
}

function statusLabel(status: Partner['status']) {
  return {
    online: '在线',
    connecting: '连接中',
    busy: '工作中',
    awaiting_confirmation: '等待确认',
    offline: '离线',
    failed: '连接异常',
  }[status];
}
