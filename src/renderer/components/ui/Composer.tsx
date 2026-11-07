import { CYBERBOSS_CHAT_IMAGE_HINT, CYBERBOSS_CHAT_IMAGE_LIMIT, CYBERBOSS_CHAT_IMAGE_MAX_BYTES, cyberBossChatAttachmentError, cyberBossChatAttachmentHint, type CyberBossChatFileCapabilities } from '../../../shared/cyberBossChatAttachments';
import { parseSessionCommand, type SessionCommandName } from '../../../shared/sessionCommands';
import { useGeneralSettings } from '../../app/useGeneralSettings';
import { isMessageSendKey } from '../../app/sendShortcut';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useAttachmentTransfer } from './useAttachmentTransfer';
import { Bot, Check, File, Flame, Hand, Image as ImageIcon, ListTodo, LockKeyhole, Mic, Paperclip, Send, Square, X } from 'lucide-react';
import { MAX_MESSAGE_ATTACHMENT_BYTES, type AttachmentCapabilities, type PendingMessageAttachment, type PermissionMode, type PlanMode } from '../../../shared/agentProtocol';
import type { MessageQuote } from '../../types/domain';
import { MessageQuoteCard } from '../chat/MessageQuoteCard';

interface ComposerProps {
  placeholder: string;
  onSend: (value: string, attachments: PendingMessageAttachment[], quote?: MessageQuote) => void | boolean | Promise<void | boolean>;
  draftKey?: string;
  compact?: boolean;
  busy?: boolean;
  allowBusySend?: boolean;
  pendingGuidance?: { content: string; quote?: MessageQuote; state: 'staged' | 'deferred' | 'sending'; error?: string };
  onSendPendingGuidance?: () => void;
  onDiscardPendingGuidance?: () => void;
  pendingGuidanceSendDisabled?: boolean;
  disabled?: boolean;
  onCancel?: () => void;
  attachmentsEnabled?: boolean;
  allowLocalReferences?: true;
  attachmentDisabledReason?: string;
  cyberBossChat?: boolean;
  cyberBossFileCapabilities?: CyberBossChatFileCapabilities;
  attachmentCapabilities?: AttachmentCapabilities;
  permissionMode?: PermissionMode;
  permissionDisabledReason?: string;
  automaticPermissionAvailable?: boolean;
  automaticPermissionDisabledReason?: string;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  planMode?: PlanMode;
  planAvailable?: boolean;
  planDisabledReason?: string;
  onPlanModeChange?: (mode: PlanMode) => void;
  onSessionCommand?: (command: SessionCommandName) => void | Promise<void>;
  onCompactSession?: () => void;
  compactDisabledReason?: string;
  reloadDisabledReason?: string;
  focusRequestKey?: number;
  pendingQuote?: MessageQuote;
  onRemovePendingQuote?: () => void;
}

const composerDrafts = new Map<string, string>();

const permissionOptions: Array<{ mode: PermissionMode; label: string; description: string; icon: typeof LockKeyhole }> = [
  { mode: 'read_only', label: '只读', description: '只允许读取与分析', icon: LockKeyhole },
  { mode: 'manual', label: '手动审批', description: '变更操作逐次询问', icon: Hand },
  { mode: 'automatic', label: '自动审批', description: '安全写入自动执行，高风险操作仍询问', icon: Bot },
  { mode: 'full', label: '完整权限', description: '使用伙伴可提供的最高权限', icon: Flame },
];

export function Composer({ placeholder, onSend, draftKey, compact = false, busy = false, allowBusySend = false, pendingGuidance, onSendPendingGuidance, onDiscardPendingGuidance, pendingGuidanceSendDisabled = false, disabled = false, onCancel, attachmentsEnabled = false, allowLocalReferences, cyberBossChat = false, cyberBossFileCapabilities, attachmentDisabledReason = '当前伙伴暂不支持附件', attachmentCapabilities, permissionMode = 'manual', permissionDisabledReason, automaticPermissionAvailable = true, automaticPermissionDisabledReason = '当前伙伴不支持自动审批', onPermissionModeChange, planMode = 'default', planAvailable = false, planDisabledReason = '当前伙伴暂不支持计划模式', onPlanModeChange, onSessionCommand, onCompactSession, compactDisabledReason, reloadDisabledReason, focusRequestKey = 0, pendingQuote, onRemovePendingQuote }: ComposerProps) {
  const { settings: { sendShortcut }, available: sendShortcutReady } = useGeneralSettings();
  const [value, setValue] = useState(() => draftKey ? composerDrafts.get(draftKey) ?? '' : '');
  const [attachments, setAttachments] = useState<PendingMessageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const attachmentsRef = useRef<PendingMessageAttachment[]>([]);
  const mounted = useRef(true);
  const addingAttachments = useRef(false);
  const sending = useRef(false);
  const [preparingAttachments, setPreparingAttachments] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [openMenu, setOpenMenu] = useState<'permission' | 'commands' | null>(null);
  const PermissionIcon = permissionOptions.find((item) => item.mode === permissionMode)?.icon ?? Hand;
  const permissionLabel = permissionOptions.find((item) => item.mode === permissionMode)?.label ?? '手动审批';

  const updateAttachments = (next: PendingMessageAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const ids = attachmentsRef.current.map(item => item.selectionId);
      if (ids.length) void window.asteriumAttachments?.discard(ids);
    };
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, compact ? 42 : 52), 144)}px`;
  }, [value, compact]);

  useEffect(() => {
    if (disabled || (busy && !allowBusySend)) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [disabled, busy, allowBusySend, placeholder, focusRequestKey]);

  const typedCommand = onSessionCommand ? parseSessionCommand(value, Boolean(attachments.length), Boolean(pendingQuote)) : undefined;
  const statusQuery = typedCommand === 'status';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (addingAttachments.current || sending.current) return;
    const next = value.trim();
    if (typedCommand && onSessionCommand) {
      if (typedCommand !== 'status' && (busy || disabled || (typedCommand === 'compact' ? compactDisabledReason : reloadDisabledReason) || pendingGuidance)) return;
      setValue(''); if (draftKey) composerDrafts.delete(draftKey);
      await onSessionCommand(typedCommand);
      return;
    }
    if ((!next && (!attachments.length || pendingQuote)) || pendingGuidance || (busy && !allowBusySend) || disabled) return;
    if (cyberBossChat) {
      const problem = cyberBossChatAttachmentError(attachments.filter(item => !item.localReference), cyberBossFileCapabilities);
      if (problem) {
        setAttachmentError(cyberBossChatAttachmentHint(problem, cyberBossFileCapabilities) ?? '请重新选择附件。');
        return;
      }
    }
    sending.current = true;
    try {
      const sent = await (pendingQuote ? onSend(next, attachments, pendingQuote) : onSend(next, attachments));
      if (sent === false) {
        if (attachments.some(item => item.localReference)) setAttachmentError('未能发送本地引用，请确认原文件仍在原处。');
        return;
      }
    } finally {
      sending.current = false;
    }
    setValue('');
    if (draftKey) composerDrafts.delete(draftKey);
    updateAttachments([]);
    setAttachmentError('');
  };

  const cyberBossImagesOnly = cyberBossChat && !cyberBossFileCapabilities;
  const attachmentLimit = allowLocalReferences ? 10 : cyberBossImagesOnly ? CYBERBOSS_CHAT_IMAGE_LIMIT : cyberBossFileCapabilities?.maxAttachments ?? 10;
  const attachmentLabel = cyberBossImagesOnly && !allowLocalReferences ? '添加图片' : '添加图片或文件';
  const addAttachments = async (load: (remaining: number) => Promise<PendingMessageAttachment[]>, fallbackError: string) => {
    const api = window.asteriumAttachments;
    if (!api || addingAttachments.current || sending.current) return;
    addingAttachments.current = true;
    setPreparingAttachments(true);
    setAttachmentError('');
    try {
      const remaining = attachmentLimit - attachmentsRef.current.length;
      if (remaining < 1) throw new Error('ATTACHMENT_COUNT_LIMIT');
      const chosen = await load(remaining);
      if (!chosen.length) return;
      const combined = [...attachmentsRef.current, ...chosen];
      const problem = cyberBossChat ? cyberBossChatAttachmentError(combined.filter(item => !item.localReference), cyberBossFileCapabilities) : undefined;
      if (!mounted.current || problem) {
        await api.discard(chosen.map(item => item.selectionId));
        if (mounted.current && problem) setAttachmentError(cyberBossChatAttachmentHint(problem, cyberBossFileCapabilities) ?? fallbackError);
        return;
      }
      updateAttachments(combined);
    } catch (error) {
      if (!mounted.current) return;
      const detail = error instanceof Error ? error.message : '';
      const limitError = detail.includes('ATTACHMENT_TOO_LARGE') || detail.includes('ATTACHMENT_COUNT_LIMIT');
      setAttachmentError(cyberBossImagesOnly && limitError ? CYBERBOSS_CHAT_IMAGE_HINT
        : detail.includes('ATTACHMENT_TOO_LARGE') ? '单个附件不能超过 20MB。'
        : detail.includes('ATTACHMENT_COUNT_LIMIT') ? `一次最多发送 ${attachmentLimit} 个附件。` : fallbackError);
    } finally {
      addingAttachments.current = false;
      if (mounted.current) setPreparingAttachments(false);
    }
  };

  const chooseAttachments = () => {
    const api = window.asteriumAttachments;
    if (!api || !attachmentsEnabled || disabled || busy) return;
    return addAttachments(
      (remaining) => {
        if (allowLocalReferences) return api.choose(remaining, undefined, true);
        return cyberBossImagesOnly ? api.choose(remaining, 'cyberboss_images') : api.choose(remaining);
      },
      '未能添加附件。',
    );
  };

  const maxImageBytes = cyberBossChat ? cyberBossFileCapabilities?.maxImageBytes ?? CYBERBOSS_CHAT_IMAGE_MAX_BYTES : MAX_MESSAGE_ATTACHMENT_BYTES;
  const { draggingFiles, onPaste, onDragOver, onDragLeave, onDrop } = useAttachmentTransfer(attachmentsEnabled && !disabled && !busy, addAttachments, maxImageBytes, setAttachmentError, allowLocalReferences);

  const removeAttachment = (selectionId: string) => {
    updateAttachments(attachmentsRef.current.filter((item) => item.selectionId !== selectionId));
    void window.asteriumAttachments?.discard([selectionId]);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (window.asteriumGeneralSettings && !sendShortcutReady) return;
    if (!isMessageSendKey(event.nativeEvent, sendShortcut)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const editor = <textarea ref={inputRef} rows={compact ? 1 : 2} value={value} onChange={(event) => { const next = event.target.value; setValue(next); if (draftKey) composerDrafts.set(draftKey, next); }} onKeyDown={handleKeyDown} onPaste={onPaste} placeholder={placeholder} aria-label={placeholder} disabled={disabled && !onSessionCommand} autoFocus={!disabled} />;
  const attachmentButton = <button className={compact ? 'round-button' : 'composer-tool-button'} type="button" disabled={disabled || busy || preparingAttachments || !attachmentsEnabled || attachments.length >= attachmentLimit} title={attachmentsEnabled ? attachmentLabel : attachmentDisabledReason} aria-label={attachmentLabel} onClick={() => void chooseAttachments()}>
    <Paperclip size={compact ? 19 : 18} />
    {compact ? <span className="sr-only">{attachmentLabel}</span> : <span>{cyberBossImagesOnly ? '图片' : '附件'}</span>}
  </button>;
  const stopButton = <button className={compact ? 'round-button round-button--primary' : 'composer-stop'} type="button" disabled={!onCancel} onClick={onCancel} title={onCancel ? '停止当前任务' : '当前桥接暂不支持远程取消'} aria-label={onCancel ? '停止当前任务' : '当前桥接暂不支持远程取消'}>
    <Square size={compact ? 17 : 14} fill="currentColor" />
    {compact && <span className="sr-only">停止当前任务</span>}
  </button>;
  const primaryButton = statusQuery ? (
    <button className="composer-submit" type="submit"><Send size={17} /><span>查询状态</span></button>
  ) : busy && disabled && !onCancel ? (
    <button className="composer-submit" type="button" disabled>处理中…</button>
  ) : busy && allowBusySend ? (
    <div className="composer-run-actions">
      <button className="composer-submit composer-submit--guidance" type="submit" disabled={disabled || Boolean(pendingGuidance) || !value.trim()} aria-label="暂存中途消息">
        <Send size={16} /><span>暂存</span>
      </button>
      {stopButton}
    </div>
  ) : busy ? (
    <button className={compact ? 'round-button round-button--primary' : 'composer-submit'} type="button" disabled={!onCancel} onClick={onCancel} title={onCancel ? '停止当前任务' : '当前桥接暂不支持远程取消'} aria-label={onCancel ? '停止当前任务' : '当前桥接暂不支持远程取消'}>
      <Square size={compact ? 17 : 15} fill="currentColor" />
      {compact ? <span className="sr-only">停止当前任务</span> : <span>停止</span>}
    </button>
  ) : (
    <button className={compact ? 'round-button round-button--primary' : 'composer-submit'} type="submit" disabled={disabled || preparingAttachments || Boolean(pendingGuidance) || (!value.trim() && (!attachments.length || Boolean(pendingQuote)))}>
      <Send size={compact ? 20 : 17} />
      {compact ? <span className="sr-only">发送</span> : <span>发送</span>}
    </button>
  );

  return (
    <form className={`composer ${compact ? 'composer--compact' : ''}${draggingFiles ? ' attachment-drop-active' : ''}`} onSubmit={submit} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {!compact && pendingGuidance && <section className={`composer-guidance composer-guidance--${pendingGuidance.state}`} aria-label="待发送的中途消息">
        <div className="composer-guidance__body"><small>{pendingGuidance.state === 'deferred' ? '等待当前回复结束后自动发送' : pendingGuidance.state === 'sending' ? '正在发送' : busy ? '已暂存 · 点击后发送' : '当前回复已结束 · 可作为下一轮发送'}</small>{pendingGuidance.quote && <MessageQuoteCard quote={pendingGuidance.quote} className="message-quote-card--guidance" />}<strong>{pendingGuidance.content}</strong>{pendingGuidance.error && <em>{pendingGuidance.error}</em>}</div>
        <div className="composer-guidance__actions">
          {pendingGuidance.state === 'staged' && <button type="button" className="composer-guidance__send" disabled={pendingGuidanceSendDisabled} onClick={onSendPendingGuidance}><Send size={14} /><span>{busy ? '发送' : '下一轮发送'}</span></button>}
          {pendingGuidance.state !== 'sending' && <button type="button" className="composer-guidance__discard" onClick={onDiscardPendingGuidance} aria-label="取消待发送消息" title="取消待发送消息"><X size={14} /></button>}
        </div>
      </section>}
      {!compact && pendingQuote && <MessageQuoteCard quote={pendingQuote} removable onRemove={onRemovePendingQuote} className="message-quote-card--composer" />}
      {attachments.length > 0 && <div className="composer-attachments">{attachments.map((attachment) => <PendingAttachmentCard key={attachment.selectionId} attachment={attachment} onRemove={() => removeAttachment(attachment.selectionId)} />)}</div>}
      {!cyberBossChat && attachments.some((attachment) => attachment.mediaType.startsWith('image/') && !canViewImage(attachment, attachmentCapabilities)) && <small className="composer-attachment-error">当前伙伴无法查看其中的图片；仍可发送，但伙伴只会收到附件元数据。</small>}
      {attachmentError && <small className="composer-attachment-error">{attachmentError}</small>}
      {compact ? <>
        {attachmentButton}
        {editor}
        <button className="round-button" type="button" disabled title="语音功能将在后续接入"><Mic size={20} /><span className="sr-only">语音（后续开放）</span></button>
        {primaryButton}
      </> : <>
        {editor}
        <div className="composer-toolbar">
          <div className="composer-toolbar__actions">
            {attachmentButton}
            <div className="composer-menu-anchor">
              <button className={`composer-tool-button permission-button permission-button--${permissionMode}`} type="button" disabled={disabled || busy || !onPermissionModeChange} title={permissionDisabledReason ?? `权限模式：${permissionLabel}`} aria-label={`权限模式：${permissionLabel}`} aria-expanded={openMenu === 'permission'} onClick={() => setOpenMenu((current) => current === 'permission' ? null : 'permission')}><PermissionIcon size={18} /><span>{permissionLabel}</span></button>
              {openMenu === 'permission' && <div className="composer-popover composer-permission-menu" role="menu" aria-label="选择权限模式">{permissionOptions.map((option) => {
                const Icon = option.icon;
                const unavailable = option.mode === 'automatic' && !automaticPermissionAvailable;
                return <button type="button" role="menuitemradio" aria-checked={permissionMode === option.mode} disabled={unavailable} title={unavailable ? automaticPermissionDisabledReason : option.description} key={option.mode} onClick={() => { onPermissionModeChange?.(option.mode); setOpenMenu(null); }}><Icon size={16} /><span><strong>{option.label}</strong><small>{unavailable ? automaticPermissionDisabledReason : option.description}</small></span>{permissionMode === option.mode && <Check size={14} />}</button>;
              })}</div>}
            </div>
            <div className="composer-menu-anchor">
              <button className={`composer-tool-button command-button${planMode === 'plan' ? ' is-active' : ''}`} type="button" disabled={(disabled || busy) && !onSessionCommand} title="指令" aria-label="指令" aria-expanded={openMenu === 'commands'} onClick={() => setOpenMenu((current) => current === 'commands' ? null : 'commands')}><ListTodo size={18} /><span>{planMode === 'plan' ? '计划模式' : '指令'}</span></button>
              {openMenu === 'commands' && <div className="composer-popover composer-command-menu" role="menu" aria-label="指令">
                {onSessionCommand && <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); void onSessionCommand('status'); }}><ListTodo size={16} /><span><strong>查看会话状态</strong><small>status · 线程、模型、权限与 Plan</small></span></button>}
                <button type="button" role="menuitemcheckbox" aria-checked={planMode === 'plan'} disabled={!planAvailable || busy || disabled} title={!planAvailable ? planDisabledReason : '使用计划模式'} onClick={() => { onPlanModeChange?.(planMode === 'plan' ? 'default' : 'plan'); setOpenMenu(null); }}><ListTodo size={16} /><span><strong>计划模式</strong><small>{planAvailable ? '规划期间可提问，不执行修改' : planDisabledReason}</small></span>{planMode === 'plan' && <Check size={14} />}</button>
                <button type="button" role="menuitem" disabled={!onCompactSession || Boolean(compactDisabledReason) || busy || disabled} title={compactDisabledReason ?? '压缩模型使用的上下文，聊天记录保留'} onClick={() => { setOpenMenu(null); onCompactSession?.(); }}><ListTodo size={16} /><span><strong>压缩当前对话</strong><small>{compactDisabledReason ?? 'compact · 缩短上下文，保留聊天记录'}</small></span></button>
                {onSessionCommand && (['reload-user', 'reload-persona'] as const).map((command) => <button type="button" role="menuitem" key={command} disabled={Boolean(reloadDisabledReason) || busy || disabled} title={reloadDisabledReason ?? '读取最新资料并请伙伴简短确认'} onClick={() => { setOpenMenu(null); void onSessionCommand(command); }}><ListTodo size={16} /><span><strong>{command === 'reload-user' ? '重读用户资料' : '重读伙伴人设'}</strong><small>{reloadDisabledReason ?? command}</small></span></button>)}
              </div>}
            </div>
          </div>
          {primaryButton}
        </div>
      </>}
    </form>
  );
}

export function PendingAttachmentCard({ attachment, onRemove, disabled = false }: { attachment: PendingMessageAttachment; onRemove: () => void; disabled?: boolean }) {
  const [thumbnail, setThumbnail] = useState('');
  const image = attachment.mediaType.startsWith('image/');
  useEffect(() => {
    let active = true;
    if (image) void window.asteriumAttachments?.thumbnail(attachment.selectionId).then((value) => { if (active) setThumbnail(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [attachment.selectionId, image]);
  return <div className={`pending-attachment ${image ? 'pending-attachment--image' : ''}`}>
    {thumbnail ? <img src={thumbnail} alt={attachment.name} /> : image ? <ImageIcon size={18} /> : <File size={18} />}
    <span><strong>{attachment.name}</strong><small>{formatBytes(attachment.sizeBytes)}{attachment.localReference ? ' · 本地引用' : ''}</small></span>
    <button type="button" disabled={disabled} onClick={onRemove} aria-label={`移除 ${attachment.name}`} title="移除附件"><X size={14} /></button>
  </div>;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function canViewImage(attachment: PendingMessageAttachment, capabilities?: AttachmentCapabilities) {
  if (!capabilities?.supportsImageInput || capabilities.attachmentTransport === 'metadata_only') return false;
  if (attachment.sizeBytes > capabilities.maxImageBytes) return false;
  return capabilities.acceptedMimeTypes.includes(attachment.mediaType);
}
