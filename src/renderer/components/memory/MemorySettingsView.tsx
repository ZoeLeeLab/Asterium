import { Archive, BadgeCheck, Brain, CircleHelp, FolderKanban, Grid2X2, HeartHandshake, Link2, MessageSquarePlus, Pencil, RefreshCw, Repeat2, RotateCcw, Search, SlidersHorizontal, Sparkles, Trash2, UserRound, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MemoryArchiveBriefing, MemoryRecord, MemorySourceReadResult, MemoryStatus, MemoryType, MemoryWeight } from '../../../shared/memoryArchive';
import type { Conversation, GroupChat, Partner, Project } from '../../types/domain';
import type { MemorySourceNavigationState } from '../../app/memorySourceNavigation';
import { Avatar } from '../ui/Avatar';
import { Modal } from '../ui/Modal';
import { memoryStatusLabels, memoryTypeLabels } from './memoryLabels';
import { MemoryImportPanel } from './MemoryImportPanel';
import { MemoryFallbackSettings } from './MemoryFallbackSettings';

interface MemorySettingsViewProps {
  initialPartnerId?: string;
  partners: Partner[];
  conversations: Conversation[];
  groupChats: GroupChat[];
  projects: Project[];
  onTrashRemovedPartner: (partnerId: string) => Promise<boolean>;
}

const memoryTypeIcons: Record<MemoryType, LucideIcon> = {
  self_summary: UserRound,
  relationship_with_user: HeartHandshake,
  stable_fact: BadgeCheck,
  long_term_project: FolderKanban,
  recurring_behavior_pattern: Repeat2,
  preference_and_collaboration: SlidersHorizontal,
  open_question_and_follow_up: CircleHelp,
};

export function MemorySettingsView({ partners, conversations, groupChats, projects, onTrashRemovedPartner, initialPartnerId = '' }: MemorySettingsViewProps) {
  const navigate = useNavigate();
  const managedPartners = useMemo(() => partners.filter((partner) => partner.profileManagement?.memoryMode === 'asterium' && !partner.managedDataDeletedAt), [partners]);
  const [selectedPartnerId, setSelectedPartnerId] = useState(initialPartnerId);
  const [archiveScrollbarVisible, setArchiveScrollbarVisible] = useState(false);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [fallbackMemoryIds, setFallbackMemoryIds] = useState<string[]>([]);
  const [briefing, setBriefing] = useState<MemoryArchiveBriefing>();
  const [briefingOpen, setBriefingOpen] = useState(true);
  const [text, setText] = useState('');
  const [type, setType] = useState<MemoryType | ''>('');
  const [status, setStatus] = useState<MemoryStatus | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<MemoryRecord>();
  const [sourceResult, setSourceResult] = useState<MemorySourceReadResult>();
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [editing, setEditing] = useState<MemoryRecord | 'new'>();
  const [comment, setComment] = useState('');
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const [showTrash, setShowTrash] = useState(false);
  const [pendingLifecycle, setPendingLifecycle] = useState<{ kind: 'delete' | 'restore' | 'purge'; record: MemoryRecord }>();
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<Set<string>>(() => new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [partnerTrashTarget, setPartnerTrashTarget] = useState<Partner>();
  const [partnerTrashBusy, setPartnerTrashBusy] = useState(false);
  const [partnerTrashError, setPartnerTrashError] = useState('');

  const partnerId = managedPartners.some((partner) => partner.id === selectedPartnerId)
    ? selectedPartnerId
    : managedPartners[0]?.id ?? '';

  const load = useCallback(async () => {
    if (!partnerId || !window.asteriumMemory) return;
    setBusy(true);
    setError('');
    try {
      const [archive, nextBriefing] = await Promise.all([
        window.asteriumMemory.query({ partnerId, includeDeleted: showTrash || undefined, text: text || undefined, types: type ? [type] : undefined, statuses: status ? [status] : undefined, limit: 100 }),
        window.asteriumMemory.briefing(partnerId),
      ]);
      setRecords(archive.records);
      setFallbackMemoryIds(archive.fallbackMemoryIds ?? []);
      setBriefing(nextBriefing);
    } catch {
      setRecords([]);
      setBriefing(undefined);
      setError('记忆档案暂时无法读取。');
    } finally {
      setBusy(false);
    }
  }, [partnerId, showTrash, status, text, type]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => window.asteriumMemory?.onChanged((change) => {
    if (change.partnerId === partnerId) void load();
  }), [load, partnerId]);

  const readSource = async (record: MemoryRecord, sourceIndex: number) => {
    if (!window.asteriumMemory) return;
    setSourceBusy(true);
    setSourceError('');
    try {
      const results = await window.asteriumMemory.readSource({ partnerId, memoryId: record.memoryId, sourceIndex });
      setSourceResult(results.find((entry) => entry.index === sourceIndex)?.result);
    } catch {
      setSourceResult(undefined);
      setSourceError('来源上下文暂时无法读取。');
    } finally {
      setSourceBusy(false);
    }
  };

  const appendComment = async (record: MemoryRecord) => {
    if (!window.asteriumMemory || !comment.trim()) return;
    setMutationBusy(true);
    setMutationError('');
    try {
      const updated = await window.asteriumMemory.comment({ partnerId, memoryId: record.memoryId, expectedUpdatedAt: record.updatedAt, content: comment.trim() });
      setDetail(updated);
      setComment('');
      await load();
    } catch (caught) {
      setMutationError(memoryMutationError(caught));
    } finally {
      setMutationBusy(false);
    }
  };

  const runLifecycle = async () => {
    if (!window.asteriumMemory || !pendingLifecycle) return;
    setMutationBusy(true);
    setMutationError('');
    const request = { partnerId, memoryId: pendingLifecycle.record.memoryId, expectedUpdatedAt: pendingLifecycle.record.updatedAt };
    try {
      if (pendingLifecycle.kind === 'delete') await window.asteriumMemory.softDelete(request);
      else if (pendingLifecycle.kind === 'restore') await window.asteriumMemory.restore(request);
      else await window.asteriumMemory.purge(request);
      setPendingLifecycle(undefined);
      setDetail(undefined);
      await load();
    } catch (caught) {
      setMutationError(memoryLifecycleError(caught));
    } finally {
      setMutationBusy(false);
    }
  };

  const runBulkDelete = async () => {
    if (!window.asteriumMemory || selectedMemoryIds.size === 0) return;
    setMutationBusy(true);
    setMutationError('');
    try {
      const selected = records.filter((record) => selectedMemoryIds.has(record.memoryId) && !record.deletedAt);
      for (const record of selected) {
        await window.asteriumMemory.softDelete({ partnerId, memoryId: record.memoryId, expectedUpdatedAt: record.updatedAt });
      }
      setSelectedMemoryIds(new Set());
      setBulkSelectMode(false);
      setBulkDeleteOpen(false);
      await load();
    } catch (caught) {
      setMutationError(memoryLifecycleError(caught));
    } finally {
      setMutationBusy(false);
    }
  };

  const trashRemovedPartner = async () => {
    if (!partnerTrashTarget) return;
    setPartnerTrashBusy(true);
    setPartnerTrashError('');
    try {
      const trashed = await onTrashRemovedPartner(partnerTrashTarget.id);
      if (!trashed) throw new Error('PARTNER_PROFILE_TRASH_FAILED');
      setPartnerTrashTarget(undefined);
      setSelectedPartnerId('');
    } catch {
      setPartnerTrashError('伙伴资料未能移入 Windows 回收站，请稍后重试。');
    } finally {
      setPartnerTrashBusy(false);
    }
  };

  const partner = managedPartners.find((item) => item.id === partnerId);
  const visibleRecords = showTrash ? records.filter((record) => record.deletedAt) : records.filter((record) => !record.deletedAt);
  const openLiveSource = sourceResult?.state === 'live' ? (() => {
    const source = sourceResult.source;
    if (source.kind === 'imported_text') return undefined;
    if (source.kind === 'single_chat') {
      const conversation = conversations.find((item) => item.id === source.conversationId && !item.isArchived);
      if (!conversation) return undefined;
      return () => navigate('/chat', { state: { from: '/settings/partners', memorySourceTarget: { kind: 'single_chat', conversationId: conversation.id, messageId: source.messageId } } satisfies MemorySourceNavigationState });
    }
    const group = groupChats.find((item) => item.id === source.roomId && !item.archivedAt);
    if (!group || !projects.some((item) => item.id === group.projectId)) return undefined;
    return () => navigate('/studio/discussion', { state: { from: '/settings/partners', memorySourceTarget: { kind: 'studio', roomId: group.id, projectId: group.projectId, messageId: source.messageId } } satisfies MemorySourceNavigationState });
  })() : undefined;
  return <>
    <header className="settings-heading"><div><span><Brain size={24} /></span><div><h1>记忆管理</h1><p>查看由星丛托管的伙伴记忆档案与确定性会话简报。</p></div></div><div className="memory-heading-actions"><button className={showTrash ? 'secondary-button active' : 'secondary-button'} type="button" disabled={!partnerId} onClick={() => { setShowTrash((current) => !current); setDetail(undefined); setBulkSelectMode(false); setSelectedMemoryIds(new Set()); }}><Archive size={15} />{showTrash ? '返回档案' : '归档库'}</button><button className="secondary-button" type="button" disabled={busy || !partnerId} onClick={() => void load()}><RefreshCw size={15} />刷新</button></div></header>
    <section className="memory-settings-view">
      {!managedPartners.length ? <div className="friendly-empty"><Brain size={36} /><h2>没有由星丛管理记忆的伙伴</h2><p>本地伙伴可在伙伴管理中选择记忆管理方式；现有伙伴继续自行管理。</p></div> : <div className="memory-management-layout">
        <aside className="memory-partner-panel"><header><strong>伙伴</strong><small>{managedPartners.length}</small></header><div className="memory-partner-list" aria-label="选择记忆伙伴">{managedPartners.map((item) => <div className={`memory-partner-item${item.id === partnerId ? ' active' : ''}${item.isRemoved ? ' is-removed' : ''}`} key={item.id}><button type="button" onClick={() => { setSelectedPartnerId(item.id); setBulkSelectMode(false); setSelectedMemoryIds(new Set()); }}><Avatar partnerId={item.id} name={item.publicIdentity.displayName} src={item.publicIdentity.avatarDataUrl} accent={item.accent} size="sm" source={item.sourceMode} /><span><strong>{item.publicIdentity.displayName}</strong><small>{item.isRemoved ? '已移除 · 档案保留' : '星丛托管'}</small></span></button>{item.isRemoved && <button className="memory-partner-trash" type="button" aria-label={`删除已移除伙伴 ${item.publicIdentity.displayName}`} title="移入 Windows 回收站" onClick={() => { setPartnerTrashTarget(item); setPartnerTrashError(''); }}><Trash2 size={14} /></button>}</div>)}</div></aside>
        <main className="memory-content-panel">
          <MemoryFallbackSettings partnerId={partnerId} eligible={Boolean(partner && !partner.isRemoved && partner.sourceMode !== 'existing_thread')} />
          {partner && !partner.isRemoved && <MemoryImportPanel key={partnerId} partnerId={partnerId} />}
          <details className="memory-briefing-card" open={briefingOpen} onToggle={(event) => setBriefingOpen(event.currentTarget.open)}><summary><span><Sparkles size={17} /><strong>会话记忆简报</strong></span><small>{briefing?.logicalDate ?? '确定性生成'}</small></summary>{briefing ? <pre>{briefing.content}</pre> : <p>{busy ? '正在生成简报…' : '暂无简报。'}</p>}</details>
          <section className="memory-archive-panel">
            <header><div><Archive size={18} /><span><strong>{partner?.publicIdentity.displayName ?? '伙伴'}的{showTrash ? '归档库' : '记忆档案'}</strong><small>{visibleRecords.length} 条当前结果</small></span></div></header>
            <nav className="memory-type-tabs" aria-label="按记忆类型分类"><button className={type === '' ? 'active' : ''} type="button" aria-pressed={type === ''} onClick={() => { setType(''); setBulkSelectMode(false); setSelectedMemoryIds(new Set()); }}><Grid2X2 size={15} /><span>全部</span></button>{Object.entries(memoryTypeLabels).map(([value, label]) => { const Icon = memoryTypeIcons[value as MemoryType]; return <button className={type === value ? 'active' : ''} type="button" aria-pressed={type === value} key={value} onClick={() => { setType(value as MemoryType); setBulkSelectMode(false); setSelectedMemoryIds(new Set()); }}><Icon size={15} /><span>{label}</span></button>; })}</nav>
            <div className="memory-filter-row"><label><Search size={15} /><input aria-label="搜索记忆" value={text} placeholder="搜索正文、标签或补充记录" onChange={(event) => { setText(event.target.value); setBulkSelectMode(false); setSelectedMemoryIds(new Set()); }} /></label><select aria-label="筛选记忆状态" value={status} onChange={(event) => { setStatus(event.target.value as MemoryStatus | ''); setBulkSelectMode(false); setSelectedMemoryIds(new Set()); }}><option value="">全部状态</option>{Object.entries(memoryStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>{!showTrash && <div className="memory-bulk-actions"><button className={bulkSelectMode ? 'secondary-button active' : 'secondary-button'} type="button" onClick={() => { setBulkSelectMode((current) => !current); setSelectedMemoryIds(new Set()); }}><Trash2 size={14} />{bulkSelectMode ? '取消删除' : '批量删除'}</button>{bulkSelectMode && selectedMemoryIds.size > 0 && <button className="danger-button" type="button" onClick={() => { setBulkDeleteOpen(true); setMutationError(''); }}><Trash2 size={14} />删除所选（{selectedMemoryIds.size}）</button>}</div>}</div>
            {error && <p className="form-error">{error}</p>}
            {busy ? <div className="memory-loading">正在读取结构化记忆档案…</div> : visibleRecords.length ? <div
              className={`memory-record-list${archiveScrollbarVisible ? ' memory-scrollbar-visible' : ''}`}
              role="region"
              aria-label="记忆档案列表"
              tabIndex={0}
              onPointerMove={event => setArchiveScrollbarVisible(event.currentTarget.getBoundingClientRect().right - event.clientX <= 20)}
              onPointerLeave={() => setArchiveScrollbarVisible(false)}
            >{visibleRecords.map((record) => { const TypeIcon = memoryTypeIcons[record.type]; return <article className={bulkSelectMode ? 'is-selecting' : undefined} key={record.memoryId}>
              {!showTrash && bulkSelectMode && <label className="memory-record-check"><input type="checkbox" aria-label={`选择记忆：${record.body}`} checked={selectedMemoryIds.has(record.memoryId)} onChange={(event) => setSelectedMemoryIds((current) => { const next = new Set(current); if (event.target.checked) next.add(record.memoryId); else next.delete(record.memoryId); return next; })} /></label>}
              <button type="button" aria-label={`查看记忆：${record.body}`} onClick={() => { setDetail(record); setSourceResult(undefined); setSourceError(''); setMutationError(''); }}><span className="memory-record-type" aria-label={memoryTypeLabels[record.type]} title={memoryTypeLabels[record.type]}><TypeIcon size={16} /></span><strong className="memory-record-weight" aria-label={`权重 ${record.weight}`}>W{record.weight}</strong><span className="memory-record-body">{fallbackMemoryIds.includes(record.memoryId) && <small className="memory-fallback-badge">星丛兜底</small>}{record.body}</span><time title={new Date(record.occurredAt ?? record.updatedAt).toLocaleString('zh-CN')}>{formatRelativeMemoryTime(record.occurredAt ?? record.updatedAt)}</time></button>
            </article>; })}</div> : <div className="friendly-empty friendly-empty--compact"><Search size={30} /><h2>{showTrash ? '归档库为空' : '没有匹配的记忆'}</h2><p>{showTrash ? '软删除的记忆会保留在这里，等待恢复或永久删除。' : '调整分类、搜索文字或状态后再试。'}</p></div>}
          </section>
        </main>
      </div>}
    </section>
    {detail && <Modal title="记忆详情" description={`${memoryTypeLabels[detail.type]} · ${memoryStatusLabels[detail.status]} · 权重 ${detail.weight}`} size="lg" onClose={() => setDetail(undefined)}>
      {fallbackMemoryIds.includes(detail.memoryId) && <small className="memory-muted">星丛兜底 · 此记忆曾由兜底整理新增或更新</small>}
      <div className="memory-detail">
        <section className="memory-detail-primary">
          <div className="memory-detail-heading"><h3>记忆正文</h3><div>{detail.deletedAt ? <><button className="secondary-button" type="button" onClick={() => { setDetail(undefined); setPendingLifecycle({ kind: 'restore', record: detail }); }}><RotateCcw size={14} />恢复</button><button className="danger-button" type="button" onClick={() => { setDetail(undefined); setPendingLifecycle({ kind: 'purge', record: detail }); }}><Trash2 size={14} />永久删除</button></> : <><button className="secondary-button" type="button" onClick={() => { setEditing(detail); setDetail(undefined); setMutationError(''); }}><Pencil size={14} />编辑</button><button className="text-button" type="button" onClick={() => { setDetail(undefined); setPendingLifecycle({ kind: 'delete', record: detail }); }}><Trash2 size={14} />移入归档库</button></>}</div></div>
          <p className="memory-detail-body">{detail.body}</p>
          <dl><div><dt>发生时间</dt><dd>{new Date(detail.occurredAt ?? detail.createdAt).toLocaleString('zh-CN')}</dd></div><div><dt>最后更新</dt><dd>{new Date(detail.updatedAt).toLocaleString('zh-CN')}</dd></div><div><dt>标签</dt><dd>{detail.tags.length ? detail.tags.map((tag) => `#${tag}`).join(' ') : '无'}</dd></div>{detail.deletedAt && <div><dt>移入归档库</dt><dd>{new Date(detail.deletedAt).toLocaleString('zh-CN')}</dd></div>}</dl>
        </section>
        <div className="memory-detail-secondary">
          <section><h3>补充记录</h3>{detail.comments.length ? <ul>{detail.comments.map((item) => <li key={item.commentId}><p>{item.content}</p><time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></li>)}</ul> : <p className="memory-muted">还没有补充记录。</p>}{!detail.deletedAt && <form className="memory-comment-form" onSubmit={(event) => { event.preventDefault(); void appendComment(detail); }}><label><span className="sr-only">添加补充</span><textarea aria-label="添加补充" value={comment} placeholder="补充新证据、新感受或后续变化" rows={3} onChange={(event) => setComment(event.target.value)} /></label><button className="secondary-button" disabled={mutationBusy || !comment.trim()}><MessageSquarePlus size={14} />添加补充</button></form>}{mutationError && <p className="form-error">{mutationError}</p>}</section>
          <section><h3>来源锚点</h3>{detail.sources.length ? <div className="memory-source-list">{detail.sources.map((source, index) => <button type="button" key={`${source.kind}-${source.messageId}`} onClick={() => void readSource(detail, index)}><Link2 size={15} /><span><strong>{source.kind === 'imported_text' ? source.label : source.kind === 'single_chat' ? '单聊消息' : 'Studio 消息'}</strong><small>{source.messageId}</small></span></button>)}</div> : <p className="memory-muted">这条记忆没有来源锚点。</p>}
            {sourceBusy && <p className="memory-muted">正在读取来源上下文…</p>}{sourceError && <p className="form-error">{sourceError}</p>}{sourceResult && (sourceResult.source.kind === 'imported_text'
              ? <blockquote>{sourceResult.source.label} · 第 {sourceResult.source.messageId} 段<br />{sourceResult.source.excerpt}</blockquote>
              : <MemorySourceEvidence result={sourceResult} onOpen={openLiveSource} />)}
          </section>
        </div>
      </div>
    </Modal>}
    {editing && <MemoryEditor key={editing === 'new' ? `new-${partnerId}` : editing.memoryId} partnerId={partnerId} record={editing === 'new' ? undefined : editing} candidates={records} onClose={() => setEditing(undefined)} onSaved={async (saved) => { setEditing(undefined); setDetail(saved); await load(); }} />}
    {pendingLifecycle && <Modal title={pendingLifecycle.kind === 'delete' ? '移入归档库' : pendingLifecycle.kind === 'restore' ? '恢复记忆' : '永久删除记忆'} description={pendingLifecycle.kind === 'purge' ? '这是永久操作；删除后无法恢复。' : undefined} onClose={() => { setPendingLifecycle(undefined); setMutationError(''); }}>{pendingLifecycle.kind === 'purge' ? <div className="memory-delete-confirm"><div className="memory-delete-body"><div className="memory-delete-target"><span><Trash2 size={19} /></span><div><small>将永久删除</small><strong>{memoryTypeLabels[pendingLifecycle.record.type]}</strong></div></div><blockquote className="memory-delete-preview">{pendingLifecycle.record.body}</blockquote><div className="modal-warning modal-warning--danger"><Trash2 size={17} /><span><strong>删除后无法恢复</strong><small>正文、标签、补充记录和来源锚点会一并永久删除。</small></span></div><div className="memory-delete-note"><CircleHelp size={16} /><span><strong>引用保护仍然有效</strong><small>如果其他历史记忆仍引用这条记录，星丛会拒绝删除。</small></span></div>{mutationError && <p className="form-error">{mutationError}</p>}</div><footer className="modal-footer"><button className="text-button" type="button" onClick={() => setPendingLifecycle(undefined)}>取消</button><button className="danger-button" type="button" disabled={mutationBusy} onClick={() => void runLifecycle()}><Trash2 size={14} />{mutationBusy ? '处理中…' : '确认永久删除'}</button></footer></div> : pendingLifecycle.kind === 'delete' ? <div className="memory-delete-confirm"><div className="memory-delete-body"><div className="memory-delete-target"><span><Archive size={19} /></span><div><small>将移入归档库</small><strong>{memoryTypeLabels[pendingLifecycle.record.type]}</strong></div></div><blockquote className="memory-delete-preview">{pendingLifecycle.record.body}</blockquote><div className="modal-warning modal-warning--danger"><Trash2 size={17} /><span><strong>这条记忆将离开当前档案</strong><small>伙伴后续搜索和会话简报不会再使用这条已删除记忆。</small></span></div><div className="memory-delete-note"><BadgeCheck size={16} /><span><strong>之后仍可恢复</strong><small>这不是永久删除，可从归档库恢复到原档案。</small></span></div>{mutationError && <p className="form-error">{mutationError}</p>}</div><footer className="modal-footer"><button className="text-button" type="button" onClick={() => setPendingLifecycle(undefined)}>取消</button><button className="danger-button" type="button" disabled={mutationBusy} onClick={() => void runLifecycle()}><Trash2 size={14} />{mutationBusy ? '处理中…' : '确认移入归档库'}</button></footer></div> : <div className="memory-confirm"><p>恢复后，这条记忆会重新出现在伙伴档案中。</p><blockquote>{pendingLifecycle.record.body}</blockquote>{mutationError && <p className="form-error">{mutationError}</p>}<footer><button className="text-button" type="button" onClick={() => setPendingLifecycle(undefined)}>取消</button><button className="primary-button" type="button" disabled={mutationBusy} onClick={() => void runLifecycle()}>{mutationBusy ? '处理中…' : '确认恢复'}</button></footer></div>}</Modal>}
    {bulkDeleteOpen && <Modal title="批量移入归档库" description={`已选择 ${selectedMemoryIds.size} 条记忆`} onClose={() => { setBulkDeleteOpen(false); setMutationError(''); }}><div className="memory-delete-confirm"><div className="memory-delete-body"><div className="memory-delete-target"><span><Archive size={19} /></span><div><small>本次操作</small><strong>移入 {selectedMemoryIds.size} 条记忆</strong></div></div><div className="modal-warning modal-warning--danger"><Trash2 size={17} /><span><strong>所选记忆将离开当前档案</strong><small>这些记忆会一起移入星丛归档库。</small></span></div><div className="memory-delete-note"><BadgeCheck size={16} /><span><strong>之后仍可恢复</strong><small>这不是永久删除，可在归档库中逐条恢复。</small></span></div>{mutationError && <p className="form-error">{mutationError}</p>}</div><footer className="modal-footer"><button className="text-button" type="button" onClick={() => setBulkDeleteOpen(false)}>取消</button><button className="danger-button" type="button" disabled={mutationBusy} onClick={() => void runBulkDelete()}><Trash2 size={14} />{mutationBusy ? '处理中…' : '确认批量删除'}</button></footer></div></Modal>}
    {partnerTrashTarget && <Modal title="删除已移除伙伴资料" description="资料目录会进入 Windows 回收站" onClose={() => { if (!partnerTrashBusy) setPartnerTrashTarget(undefined); setPartnerTrashError(''); }}><div className="memory-partner-delete-confirm"><div className="memory-partner-delete-body"><div className="memory-partner-delete-target"><span><Trash2 size={19} /></span><div><small>将要删除</small><strong>{partnerTrashTarget.publicIdentity.displayName}</strong></div></div><div className="modal-warning modal-warning--danger"><Trash2 size={17} /><span><strong>伙伴资料将移入 Windows 回收站</strong><small>包括记忆、人设和项目工作笔记；之后仍可从 Windows 回收站恢复。</small></span></div><div className="memory-partner-delete-preserved"><BadgeCheck size={16} /><span><strong>聊天记录会保留</strong><small>现有单聊与 Studio 历史不会删除。</small></span></div>{partnerTrashError && <p className="form-error">{partnerTrashError}</p>}</div><footer className="modal-footer"><button className="text-button" type="button" disabled={partnerTrashBusy} onClick={() => setPartnerTrashTarget(undefined)}>取消</button><button className="danger-button" type="button" disabled={partnerTrashBusy} onClick={() => void trashRemovedPartner()}><Trash2 size={14} />{partnerTrashBusy ? '正在移入…' : '移入 Windows 回收站'}</button></footer></div></Modal>}
  </>;
}

interface MemoryEditorProps {
  partnerId: string;
  record?: MemoryRecord;
  candidates: MemoryRecord[];
  onClose: () => void;
  onSaved: (record: MemoryRecord) => Promise<void>;
}

function MemoryEditor({ partnerId, record, candidates, onClose, onSaved }: MemoryEditorProps) {
  const [memoryType, setMemoryType] = useState<MemoryType>(record?.type ?? 'stable_fact');
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus>(record?.status ?? 'active');
  const [body, setBody] = useState(record?.body ?? '');
  const [tags, setTags] = useState(record?.tags.join(', ') ?? '');
  const [weight, setWeight] = useState<MemoryWeight>(record?.weight ?? 3);
  const [occurredAt, setOccurredAt] = useState(record?.occurredAt ? isoToLocalInput(record.occurredAt) : '');
  const [supersededByMemoryId, setSupersededByMemoryId] = useState(record?.supersededByMemoryId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!window.asteriumMemory || !body.trim()) return;
    if (memoryStatus === 'superseded' && !supersededByMemoryId) {
      setError('标记为“已被取代”时必须选择替代记忆。');
      return;
    }
    setBusy(true);
    setError('');
    const normalizedTags = [...new Set(tags.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean))];
    try {
      const saved = record
        ? await window.asteriumMemory.update({ partnerId, memoryId: record.memoryId, expectedUpdatedAt: record.updatedAt, type: memoryType, status: memoryStatus, body: body.trim(), tags: normalizedTags, weight, occurredAt: occurredAt ? localInputToIso(occurredAt) : null, supersededByMemoryId: memoryStatus === 'superseded' ? supersededByMemoryId : null })
        : await window.asteriumMemory.create({ partnerId, type: memoryType, body: body.trim(), tags: normalizedTags, weight, occurredAt: occurredAt ? localInputToIso(occurredAt) : undefined });
      await onSaved(saved);
    } catch (caught) {
      setError(memoryMutationError(caught));
    } finally {
      setBusy(false);
    }
  };

  return <Modal title={record ? '编辑记忆' : '新增记忆'} description={record ? '保存时会校验最新版本，避免覆盖其他更新。' : '用户新增的记忆可以不绑定来源锚点。'} size="md" onClose={onClose}><form className="memory-editor" onSubmit={(event) => void submit(event)}><label>类型<select aria-label="记忆类型" value={memoryType} onChange={(event) => setMemoryType(event.target.value as MemoryType)}>{Object.entries(memoryTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{record && <label>状态<select aria-label="记忆状态" value={memoryStatus} onChange={(event) => setMemoryStatus(event.target.value as MemoryStatus)}>{Object.entries(memoryStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}<label className="memory-editor-wide">正文<textarea aria-label="记忆正文" value={body} rows={6} onChange={(event) => setBody(event.target.value)} /></label><label className="memory-editor-wide">标签（逗号分隔）<input aria-label="记忆标签" value={tags} onChange={(event) => setTags(event.target.value)} /></label><label>权重<select aria-label="记忆权重" value={weight} onChange={(event) => setWeight(Number(event.target.value) as MemoryWeight)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>发生时间（可选）<input aria-label="记忆发生时间" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>{record && memoryStatus === 'superseded' && <label className="memory-editor-wide">替代记忆<select aria-label="替代记忆" value={supersededByMemoryId} onChange={(event) => setSupersededByMemoryId(event.target.value)}><option value="">请选择</option>{candidates.filter((candidate) => candidate.memoryId !== record.memoryId && !candidate.deletedAt).map((candidate) => <option key={candidate.memoryId} value={candidate.memoryId}>{candidate.body}</option>)}</select></label>}{error && <p className="form-error memory-editor-wide">{error}</p>}<footer className="memory-editor-wide"><button className="text-button" type="button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !body.trim()}>{busy ? '保存中…' : '保存'}</button></footer></form></Modal>;
}

function isoToLocalInput(value: string) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatRelativeMemoryTime(value: string, now = Date.now()) {
  const elapsedHours = Math.max(1, Math.floor((now - new Date(value).getTime()) / 3_600_000));
  if (elapsedHours < 24) return `${elapsedHours}小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}天前`;
  return `${Math.max(1, Math.floor(elapsedDays / 30))}个月前`;
}

function localInputToIso(value: string) {
  return new Date(value).toISOString();
}

function memoryMutationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('MEMORY_RECORD_STALE')) return '这条记忆已被其他操作更新，请关闭窗口、刷新后再试。';
  if (message.includes('MEMORY_SUPERSESSION')) return '替代关系无效，请选择另一条现有记忆。';
  return '记忆保存失败，请稍后重试。';
}

function memoryLifecycleError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('MEMORY_RECORD_STALE')) return '这条记忆已被其他操作更新，请关闭窗口、刷新后再试。';
  if (message.includes('MEMORY_SUPERSESSION')) return '仍有历史记忆引用这条记录，暂时不能永久删除。';
  return '记忆操作失败，请稍后重试。';
}

const sourceStateLabels: Record<MemorySourceReadResult['state'], string> = {
  live: '原消息仍在，内容一致',
  changed: '原消息内容已变化，以下显示冻结摘录',
  frozen: '原消息已删除，以下显示冻结摘录',
  unavailable: '来源不可读取',
};

function MemorySourceEvidence({ result, onOpen }: { result: MemorySourceReadResult; onOpen?: () => void }) {
  return <div className="memory-source-evidence"><header><strong data-state={result.state}>{sourceStateLabels[result.state]}</strong>{onOpen && <button className="secondary-button" type="button" onClick={onOpen}>打开原消息</button>}</header>{result.messages.length ? <ol>{result.messages.map((message) => <li className={message.offset === 0 ? 'is-target' : ''} key={`${message.offset}-${message.messageId}`}><header><span>{message.authorType === 'user' ? '用户' : message.authorType === 'partner' ? '伙伴' : '系统'}</span><time>{new Date(message.createdAt).toLocaleString('zh-CN')}</time></header><p>{message.content}</p>{message.offset === 0 && <small>来源消息</small>}</li>)}</ol> : <p className="memory-muted">没有可显示的上下文。</p>}</div>;
}
