import { AtSign, Paperclip, Send, Square } from 'lucide-react';
import { useGeneralSettings } from '../../app/useGeneralSettings';
import { isMessageSendKey } from '../../app/sendShortcut';
import { useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import type { StudioMention } from '../../../shared/studioRuntime';
import { Avatar } from '../ui/Avatar';
import { PendingAttachmentCard } from '../ui/Composer';
import { MAX_MESSAGE_ATTACHMENT_BYTES, type PendingMessageAttachment } from '../../../shared/agentProtocol';
import { useAttachmentTransfer } from '../ui/useAttachmentTransfer';
import { useAttachmentDraft } from '../../app/attachmentDrafts';

export interface StudioMentionOption {
  partnerId: string;
  displayName: string;
  mentionName: string;
  expertise: string;
  avatarDataUrl?: string;
  accent?: string;
  disabled?: boolean;
  disabledReason?: string;
}

interface StudioComposerProps {
  placeholder: string;
  draftKey?: string;
  disabled?: boolean;
  busy?: boolean;
  mentionsEnabled?: boolean;
  members: StudioMentionOption[];
  onSend: (value: string, mentions: StudioMention[], attachments?: PendingMessageAttachment[]) => void | boolean | Promise<void | boolean>;
  onCancel?: () => void;
}

interface MentionQuery {
  start: number;
  end: number;
  value: string;
}

export function StudioComposer({ placeholder, draftKey, disabled = false, busy = false, mentionsEnabled = true, members, onSend, onCancel }: StudioComposerProps) {
  const { settings: { sendShortcut }, available: sendShortcutReady } = useGeneralSettings();
  const draft = useAttachmentDraft(draftKey);
  const { text: { value, mentions }, attachments, operation } = draft;
  const sending = operation?.kind === 'send';
  const choosing = operation?.kind === 'stage';
  const [query, setQuery] = useState<MentionQuery>();
  const [activeOption, setActiveOption] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [attachmentError, setAttachmentError] = useState('');
  const addAttachments = async (load: (remaining: number) => Promise<PendingMessageAttachment[]>, fallbackError: string) => {
    if (!window.asteriumAttachments || disabled || busy || operation) return;
    setAttachmentError('');
    try {
      await draft.stage(async current => {
        const remaining = 10 - current.length;
        if (remaining < 1) throw new Error('ATTACHMENT_COUNT_LIMIT');
        return load(remaining);
      });
    } catch (error) {
      const detail = String(error);
      if (draft.isMounted()) setAttachmentError(detail.includes('ATTACHMENT_TOO_LARGE') ? '单个附件不能超过 20MB。' : detail.includes('ATTACHMENT_COUNT_LIMIT') ? '一次最多发送 10 个附件。' : fallbackError);
    }
  };
  const chooseAttachments = () => {
    const api = window.asteriumAttachments;
    if (api) return addAttachments((remaining) => api.choose(remaining), '未能添加附件，请重试。');
  };
  const { draggingFiles, onPaste, onDragOver, onDragLeave, onDrop } = useAttachmentTransfer(!disabled && !busy && !sending, addAttachments, MAX_MESSAGE_ATTACHMENT_BYTES, setAttachmentError);
  const highlightsRef = useRef<HTMLDivElement>(null);

  const syncHighlights = () => {
    const input = inputRef.current, highlights = highlightsRef.current;
    if (input && highlights) { highlights.scrollTop = input.scrollTop; highlights.scrollLeft = input.scrollLeft; }
  };

  const options = useMemo(() => {
    if (!query) return [];
    const needle = query.value.toLocaleLowerCase();
    return members.filter((member) => !needle
      || member.mentionName.toLocaleLowerCase().includes(needle)
      || member.displayName.toLocaleLowerCase().includes(needle));
  }, [members, query]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = '0px';
    const height = Math.min(Math.max(input.scrollHeight, 48), 144);
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > 144 ? 'auto' : 'hidden';
    syncHighlights();
  }, [value]);

  const refreshQuery = (text: string, caret: number, currentMentions: StudioMention[]) => {
    if (!mentionsEnabled) return setQuery(undefined);
    const prefix = text.slice(0, caret);
    // A mention may begin directly after normal prose (for example
    // “请问@本地伙伴”), matching familiar chat-app behavior.
    const match = prefix.match(/@([^\s@，。！？、：:()（）[\]【】{}「」『』]*)$/u);
    if (!match) return setQuery(undefined);
    const valuePart = match[1] ?? '';
    const start = caret - valuePart.length - 1;
    if (currentMentions.some((mention) => mention.start !== undefined && mention.end !== undefined && start >= mention.start && start < mention.end)) return setQuery(undefined);
    setActiveOption(0);
    setQuery({ start, end: caret, value: valuePart });
  };

  const handleChange = (next: string, caret: number) => {
    const rebased = rebaseMentions(value, next, mentions);
    const detected = mentionsEnabled ? detectUniqueMentions(next, members, rebased) : [];
    draft.setText(next, detected);
    refreshQuery(next, caret, detected);
  };

  const chooseMention = (member: StudioMentionOption) => {
    if (!query || member.disabled) return;
    const label = member.mentionName || member.displayName;
    const token = `@${label}`;
    const next = `${value.slice(0, query.start)}${token} ${value.slice(query.end)}`;
    const shifted = rebaseMentions(value, next, mentions).filter((mention) => mention.end! <= query.start || mention.start! >= query.start + token.length);
    const mention: StudioMention = { partnerId: member.partnerId, label, start: query.start, end: query.start + token.length, source: 'user' };
    const nextMentions = normalizeMentions([...shifted, mention]);
    draft.setText(next, nextMentions);
    setQuery(undefined);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      const caret = query.start + token.length + 1;
      input.focus();
      input.setSelectionRange(caret, caret);
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if ((!text && !attachments.length) || disabled || busy || operation) return;
    const leading = value.indexOf(text);
    const selected = (mentionsEnabled ? mentions : [])
      .filter((mention) => mention.start !== undefined && mention.end !== undefined && mention.start >= leading && mention.end <= leading + text.length)
      .map((mention) => ({ ...mention, start: mention.start! - leading, end: mention.end! - leading }));
    setAttachmentError('');
    try {
      const sent = await draft.send(async () => attachments.length ? onSend(text, selected, attachments) : onSend(text, selected));
      if (sent && draft.isMounted()) setQuery(undefined);
    } catch {
      if (draft.isMounted()) setAttachmentError('消息未发送，附件已保留，请重试。');
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query && options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveOption((current) => (current + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
        event.preventDefault();
        chooseMention(options[activeOption]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuery(undefined);
        return;
      }
    }
    if (window.asteriumGeneralSettings && !sendShortcutReady) return;
    if (!isMessageSendKey(event.nativeEvent, sendShortcut)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return <form className={`studio-composer${draggingFiles ? ' attachment-drop-active' : ''}`} onSubmit={submit} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    {attachments.length > 0 && <div className="composer-attachments">{attachments.map(attachment => <PendingAttachmentCard key={attachment.selectionId} attachment={attachment} disabled={sending || choosing} onRemove={() => draft.remove(attachment.selectionId)} />)}</div>}
    {attachments.length > 0 && <small className="composer-attachment-error">附件将共享给本群伙伴；图片理解取决于伙伴能力，外部线程伙伴仅收到附件信息，文件需另行共享。</small>}
    {attachmentError && <small role="alert" className="composer-attachment-error">{attachmentError}</small>}
    <div className="studio-composer__editor">
      <div className="studio-composer__highlights" ref={highlightsRef} aria-hidden="true">{highlightedText(value, mentionsEnabled ? mentions : [])}{value.endsWith('\n') ? '\u200b' : null}</div>
      <textarea
        ref={inputRef}
        rows={2}
        value={value}
        disabled={disabled || sending}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => handleChange(event.target.value, event.target.selectionStart)}
        onScroll={syncHighlights}
        onClick={(event) => refreshQuery(value, event.currentTarget.selectionStart, mentions)}
        onKeyUp={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) refreshQuery(value, event.currentTarget.selectionStart, mentions);
        }}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
      />
      {query && <div className="studio-mention-picker" role="listbox" aria-label="选择要提到的伙伴">
        <header><AtSign size={14} /><span>{query.value ? '匹配的群聊成员' : '选择群聊成员'}</span></header>
        {options.map((member, index) => <button
          className={index === activeOption ? 'active' : ''}
          type="button"
          role="option"
          aria-selected={index === activeOption}
          disabled={member.disabled}
          title={member.disabledReason}
          key={member.partnerId}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => chooseMention(member)}
        >
          <Avatar partnerId={member.partnerId} name={member.displayName} src={member.avatarDataUrl} accent={member.accent} size="sm" />
          <span><strong>@{member.mentionName}</strong><small>{member.expertise || '尚未填写擅长'}</small></span>
          {member.disabled && <em>{member.disabledReason || '当前不可用'}</em>}
        </button>)}
        {!options.length && <p>没有唯一匹配的伙伴</p>}
      </div>}
    </div>
    <div className="studio-composer__toolbar">
      <button className="composer-tool-button" type="button" disabled={disabled || busy || sending || choosing || !window.asteriumAttachments || attachments.length >= 10} aria-label="添加图片或文件" title="添加图片或文件（每次最多 10 个，单个 20MB）" onClick={() => void chooseAttachments()}><Paperclip size={18} /><span>{choosing ? '正在添加…' : '附件'}</span></button>
      {busy ? <button className="composer-submit" type="button" disabled={!onCancel} onClick={onCancel} aria-label="停止本轮" title="停止当前伙伴并取消本轮剩余发言"><Square size={17} fill="currentColor" /><span>停止</span></button>
        : <button className="composer-submit" type="submit" disabled={disabled || sending || choosing || (!value.trim() && !attachments.length)} aria-label="发送"><Send size={17} /><span>发送</span></button>}
    </div>
  </form>;
}

function highlightedText(value: string, mentions: StudioMention[]) {
  const nodes: Array<string | ReactElement> = [];
  let cursor = 0;
  for (const mention of normalizeMentions(mentions)) {
    if (mention.start === undefined || mention.end === undefined || mention.start < cursor || mention.end > value.length) continue;
    nodes.push(value.slice(cursor, mention.start));
    nodes.push(<mark key={`${mention.partnerId}:${mention.start}`}>{value.slice(mention.start, mention.end)}</mark>);
    cursor = mention.end;
  }
  nodes.push(value.slice(cursor));
  return nodes;
}

function rebaseMentions(before: string, after: string, mentions: StudioMention[]) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const removedEnd = before.length - suffix;
  const insertedEnd = after.length - suffix;
  const delta = insertedEnd - removedEnd;
  return mentions.flatMap((mention) => {
    if (mention.start === undefined || mention.end === undefined) return [];
    if (mention.end <= prefix) return [mention];
    if (mention.start >= removedEnd) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    return [];
  });
}

function detectUniqueMentions(value: string, members: StudioMentionOption[], existing: StudioMention[]) {
  const aliases = new Map<string, StudioMentionOption[]>();
  for (const member of members) {
    if (member.disabled) continue;
    for (const alias of new Set([member.mentionName, member.displayName].map((item) => item.trim()).filter(Boolean))) {
      aliases.set(alias, [...(aliases.get(alias) ?? []), member]);
    }
  }
  const detected = [...existing];
  for (const [alias, matches] of aliases) {
    if (matches.length !== 1) continue;
    const expression = new RegExp(`@${escapeRegExp(alias)}(?=$|[\\s，。！？、：:()（）\\[\\]【】{}「」『』])`, 'gu');
    for (const match of value.matchAll(expression)) {
      const start = match.index;
      const end = start + match[0].length;
      if (detected.some((mention) => mention.start === start && mention.end === end)) continue;
      detected.push({ partnerId: matches[0].partnerId, label: alias, start, end, source: 'user' });
    }
  }
  return normalizeMentions(detected);
}

function normalizeMentions(mentions: StudioMention[]) {
  return [...mentions]
    .filter((mention) => mention.start !== undefined && mention.end !== undefined && mention.start < mention.end)
    .sort((left, right) => left.start! - right.start!)
    .filter((mention, index, all) => index === 0 || mention.start! >= all[index - 1].end!);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
