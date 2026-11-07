import { partnerStatusLabel } from './partnerStatusLabel';
import {
  Check,
  ChevronDown,
  CircleAlert,
  FileCheck2,
  FilePenLine,
  FileSearch,
  Globe2,
  LoaderCircle,
  ListTodo,
  MonitorCheck,
  PlugZap,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { Fragment, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { Conversation, Message, TurnOperationCategory, TurnTimelineItem } from '../../types/domain';
import { visibleAssistantText } from '../../app/messageQuote';
import { friendlyRuntimeErrorMessage } from '../../app/runtimeErrorPresentation';
import { MarkdownContent } from './MarkdownContent';
import { toolPresentation, type ToolSemantic } from './toolPresentation';
import { UserInputRow } from './UserInputCard';

interface DelegationReceipt {
  id: string;
  requestId: string;
  card: ReactNode;
}

interface TurnTimelineProps {
  message: Message;
  delegationReceipts?: DelegationReceipt[];
  partnerName: string;
  pendingAuthorization?: Conversation['pendingAuthorization'];
  pendingUserInput?: Conversation['pendingUserInput'];
  onResolveAuthorization: (decision: 'allow_once' | 'deny', persistExtensionTrust?: boolean) => void;
  onResolveUserInput: (answers: Record<string, string[]>, customAnswers?: Record<string, string>, requestId?: string) => void | Promise<void>;
  onOpenArtifact: (artifactId: string) => void;
  onQuoteSelection?: (text: string, x: number, y: number) => void;
}

type TextItem = Extract<TurnTimelineItem, { kind: 'text' }>;
type ProcessItem = Exclude<TurnTimelineItem, TextItem>;
type ReasoningItem = Extract<ProcessItem, { kind: 'reasoning' }>;
type FileItem = Extract<ProcessItem, { kind: 'file' }>;
type ActionItem = Extract<ProcessItem, { kind: 'tool' | 'computer' }>;
type ActionRow = ActionItem & { history: ActionItem[]; files: FileItem[] };
type ProcessRow = Exclude<ProcessItem, ActionItem> | ActionRow;
type ActionClusterRow = ActionRow | FileItem;
type TimelineBlock =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'reasoning'; id: string; row: ReasoningItem }
  | { kind: 'actions'; id: string; rows: ActionClusterRow[] }
  | { kind: 'delegation'; receipt: DelegationReceipt }
  | { kind: 'entry'; id: string; row: Exclude<ProcessItem, ActionItem | ReasoningItem | FileItem> };

export function TurnTimeline({ message, delegationReceipts = [], partnerName, pendingAuthorization, pendingUserInput, onResolveAuthorization, onResolveUserInput, onOpenArtifact, onQuoteSelection }: TurnTimelineProps) {
  const timeline = message.timeline ?? [];
  if (!timeline.length) return <div className="turn-timeline">
    {delegationReceipts.map(receipt => <Fragment key={receipt.id}>{receipt.card}</Fragment>)}
    {visibleAssistantText(message.content) && <QuoteableText onQuoteSelection={onQuoteSelection}><MarkdownContent>{visibleAssistantText(message.content)}</MarkdownContent></QuoteableText>}
    {message.toolNote && <details className="timeline-entry state-success"><summary><Check size={15} /><span>{message.toolNote}</span></summary></details>}
    {message.error && <div className="timeline-entry timeline-entry--error state-failure"><CircleAlert size={15} /><span>{friendlyErrorLabel(message.error.message, partnerName)}</span></div>}
  </div>;

  const blocks = buildTimelineBlocks(timeline, delegationReceipts, message.runState === 'completed');

  return <div className="turn-timeline">
    {blocks.map((block) => {
      if (block.kind === 'text') {
        const text = visibleAssistantText(block.text);
        return text ? <QuoteableText key={block.id} className="turn-text-segment" onQuoteSelection={onQuoteSelection}><MarkdownContent>{text}</MarkdownContent></QuoteableText> : null;
      }
      if (block.kind === 'reasoning') return <ReasoningRow key={block.id} row={block.row} partnerName={partnerName} />;
      if (block.kind === 'delegation') return <Fragment key={block.receipt.id}>{block.receipt.card}</Fragment>;
      if (block.kind === 'actions') return <ActionGroup key={block.id} rows={block.rows} partnerName={partnerName} onOpenArtifact={onOpenArtifact} />;
      return <TimelineRow key={block.id} row={block.row} partnerName={partnerName} pendingAuthorization={pendingAuthorization} pendingUserInput={pendingUserInput} onResolveAuthorization={onResolveAuthorization} onResolveUserInput={onResolveUserInput} onOpenArtifact={onOpenArtifact} />;
    })}
  </div>;
}

function QuoteableText({ children, className = '', onQuoteSelection }: { children: ReactNode; className?: string; onQuoteSelection?: (text: string, x: number, y: number) => void }) {
  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onQuoteSelection) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return;
    const container = event.currentTarget;
    if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return;
    const text = selection.toString().trim();
    if (!text) return;
    event.preventDefault();
    onQuoteSelection(text, event.clientX, event.clientY);
  };
  return <div className={`assistant-quote-source ${className}`.trim()} onContextMenu={handleContextMenu}>{children}</div>;
}

function ActionGroup({ rows, partnerName, onOpenArtifact }: {
  rows: ActionClusterRow[];
  partnerName: string;
  onOpenArtifact: (artifactId: string) => void;
}) {
  const renderRow = (row: ActionClusterRow) => <TimelineRow key={row.id} row={row} partnerName={partnerName}
    onResolveAuthorization={() => undefined} onResolveUserInput={() => undefined} onOpenArtifact={onOpenArtifact} />;
  const actions = rows.filter((row): row is ActionRow => row.kind !== 'file');
  const groups = actions.map(actionGroupCategory);
  const repeated = actions.length === 3 && groups.every(group => group.key === groups[0].key);
  if (actions.length <= 3 && !repeated) return <>{rows.map(renderRow)}</>;

  const counts = new Map<string, number>();
  for (const { label } of groups) counts.set(label, (counts.get(label) ?? 0) + 1);
  const label = [...counts].map(([name, count]) => `${name} ${count} 次`).join(' · ');
  const running = actions.filter(row => row.state === 'running').length;
  const failed = actions.filter(row => row.state === 'failure').length;
  const state = running ? 'running' : failed ? 'failure' : 'success';

  return <>
    <details className={`timeline-tool-group state-${state}`}>
      <summary>
        <span>
          {label}
          {running > 0 && <span className="timeline-tool-group__running"> · 正在执行 {running} 条</span>}
          {failed > 0 && <span className="timeline-tool-group__failure"> · {failed} 次失败</span>}
        </span>
        <OutcomeIcon state={state} /><ChevronDown size={12} />
      </summary>
      <div className="timeline-tool-group__body">{actions.map(renderRow)}</div>
    </details>
    {rows.filter(row => row.kind === 'file').map(renderRow)}
  </>;
}

const actionGroupLabels: Record<ToolSemantic, string> = {
  generic: '其他工具',
  file_read: '读取文件',
  file_write: '写入文件',
  directory_list: '查看目录',
  local_search: '搜索文件',
  delete: '删除内容',
  command: '电脑操作',
  web: '查资料',
  computer: '电脑操作',
  image_generation: '画图',
  collaboration: '协作',
  delegate_dispatch: '派出小弟',
  delegate_wait: '等待汇报',
  extension: '扩展能力',
  message_send: '发送消息',
  reminder_create: '创建提醒',
  notebook: '项目笔记',
  task_contract: '项目任务',
  automation: '自动化任务',
  mcp_install: '配置 MCP',
  skill_run: '运行脚本',
  workspace: '工作区设置',
};

function actionGroupCategory(row: ActionRow) {
  const { category, semantic } = actionPresentation(row);
  const label = actionGroupLabels[semantic];
  if (semantic !== 'generic') return { label, key: label };
  const name = row.kind === 'tool' ? row.presentationName ?? row.toolName : undefined;
  return { label: category === 'mcp' ? 'MCP 工具' : label, key: name?.toLowerCase() || row.toolCallId };
}

function OutcomeIcon({ state }: { state: 'running' | 'success' | 'failure' }) {
  if (state === 'running') return <LoaderCircle className="timeline-outcome is-spinning" size={15} />;
  if (state === 'failure') return <CircleAlert className="timeline-outcome" size={15} />;
  return <Check className="timeline-outcome" size={15} />;
}

function TimelineRow({ row, partnerName = '伙伴', pendingAuthorization, pendingUserInput, onResolveAuthorization, onResolveUserInput, onOpenArtifact }: {
  row: ProcessRow;
  partnerName?: string;
  pendingAuthorization?: Conversation['pendingAuthorization'];
  pendingUserInput?: Conversation['pendingUserInput'];
  onResolveAuthorization: (decision: 'allow_once' | 'deny', persistExtensionTrust?: boolean) => void;
  onResolveUserInput: (answers: Record<string, string[]>, customAnswers?: Record<string, string>, requestId?: string) => void | Promise<void>;
  onOpenArtifact: (artifactId: string) => void;
}) {
  if (row.kind === 'file') return <button className="timeline-file" type="button" onClick={() => onOpenArtifact(row.artifactId)}><FileCheck2 size={15} /><span><strong>{row.name}</strong><small>文件送到了</small></span><em>预览</em></button>;
  if (row.kind === 'authorization') {
    const active = pendingAuthorization?.authorizationId === row.authorizationId;
    return <AuthorizationRow row={{ ...row, summary: partnerStatusLabel(row.summary, partnerName) }} active={active} interactive={pendingAuthorization?.resolution !== 'display_only'} targets={active ? pendingAuthorization?.targets : undefined} extensionTrust={active ? pendingAuthorization?.extensionTrust : undefined} onResolveAuthorization={onResolveAuthorization} />;
  }
  if (row.kind === 'user_input') return <UserInputRow key={row.requestId} row={row} active={pendingUserInput?.requestId === row.requestId} onResolve={(answers, customAnswers) => onResolveUserInput(answers, customAnswers, row.requestId)} />;
  if (row.kind === 'plan') return <details className={`timeline-entry timeline-entry--plan state-${row.state}`} open={row.state === 'running'}><summary><ListTodo size={15} /><span>{row.summary}</span>{row.detail && <ChevronDown size={13} />}</summary>{row.detail && <pre>{row.detail}</pre>}</details>;
  if (row.kind === 'reasoning') return <ReasoningRow row={row} partnerName={partnerName} />;
  if (row.kind === 'tool' || row.kind === 'computer') return <OperationRow row={row} partnerName={partnerName} onOpenArtifact={onOpenArtifact} />;
  if (row.kind === 'error') return <div className="timeline-entry timeline-entry--error state-failure"><CircleAlert size={15} /><span>{friendlyErrorLabel(row.summary, partnerName)}</span></div>;
  return <div className={`timeline-entry timeline-entry--status state-${row.state}`}><OutcomeIcon state={row.state} /><span>{friendlyStatusLabel(row.summary, row.state, partnerName)}</span></div>;
}

function AuthorizationRow({ row, active, interactive, targets, extensionTrust, onResolveAuthorization }: {
  row: Extract<ProcessRow, { kind: 'authorization' }>;
  active: boolean;
  interactive: boolean;
  targets?: string[];
  extensionTrust?: NonNullable<Conversation['pendingAuthorization']>['extensionTrust'];
  onResolveAuthorization: (decision: 'allow_once' | 'deny', persistExtensionTrust?: boolean) => void;
}) {
  const nativeCommand = row.purpose === 'command_native';
  const action = nativeCommand ? '本次 Native（无沙箱）命令' : row.purpose === 'workspace_add' ? '持久加入工作区' : row.purpose === 'workspace_remove' ? '移除持久工作区' : authorizationActionLabel(row.action);
  const locations = authorizationLocations(row.detail, targets);
  const workspaceChange = row.purpose === 'workspace_add' || row.purpose === 'workspace_remove';
  const allowLabel = nativeCommand ? '仅本次无沙箱运行' : row.purpose === 'workspace_add' ? '加入工作区' : row.purpose === 'workspace_remove' ? '移除工作区' : '允许一次';
  if (!active && row.state !== 'running') {
    const allowed = row.decision !== 'deny' && row.state === 'success';
    const Icon = allowed ? ShieldCheck : ShieldX;
    const label = `${row.extensionTrustGranted ? '已持续信任扩展' : allowed ? '已允许' : '已拒绝'} · ${action}`;
    if (!locations.length) return <div className={`timeline-authorization-record state-${row.state}`}><Icon size={13} /><span>{label}</span></div>;
    return <details className={`timeline-authorization-record state-${row.state}`}>
      <summary><Icon size={13} /><span>{label}</span><ChevronDown size={12} /></summary>
      <div><p>{row.summary}</p><pre>{locations.join('\n')}</pre></div>
    </details>;
  }
  return <section className={`timeline-authorization-card risk-${row.risk ?? 'medium'}`}>
    <header><span className="timeline-authorization-card__icon"><ShieldAlert size={15} /></span><span><strong>需要你的确认</strong><small>{action}</small></span><em>{authorizationRiskLabel(row.risk)}</em></header>
    <p>{row.summary}</p>
    {nativeCommand && <small className="timeline-authorization-scope">仅批准下列命令和工作目录。本次进程不受沙箱工作区和联网开关限制，可访问当前星丛身份有权访问的电脑资源；不额外提权，不改变会话权限或全局设置。</small>}
    {extensionTrust && <small className="timeline-authorization-scope">持续信任「{extensionTrust.name}」后，{extensionTrust.kind === 'skill' ? '仅此技能包的脚本' : '此 MCP 的工具'}在已绑定 API 伙伴的普通模式免逐次确认；只读和 Plan 仍禁止执行。信任可撤销，配置或内容变更后需重新确认。</small>}
    {workspaceChange && <small className="timeline-authorization-scope">这会持续改变该伙伴的工作区，并同步到设置页；移除授权不会删除文件。</small>}
    {locations.length > 0 && <details className="timeline-authorization-targets" open={nativeCommand}><summary>{nativeCommand ? '查看命令与工作目录' : '查看请求位置'}<ChevronDown size={12} /></summary><pre>{locations.join('\n')}</pre></details>}
    {interactive ? <footer><button type="button" onClick={() => onResolveAuthorization('deny')}>拒绝</button><button type="button" onClick={() => onResolveAuthorization('allow_once')}>{allowLabel}</button>{extensionTrust && <button type="button" onClick={() => onResolveAuthorization('allow_once', true)}>允许并持续信任此 {extensionTrust.kind === 'skill' ? 'Skill' : 'MCP'}</button>}</footer> : <small>此接回伙伴只提供事件展示，请在原伙伴端处理。</small>}
  </section>;
}

function authorizationActionLabel(action: Extract<ProcessRow, { kind: 'authorization' }>['action']) {
  return ({
    read_file: '读取文件',
    write_file: '写入文件',
    delete_file: '删除文件',
    run_command: '运行脚本或命令',
    computer_control: '操作电脑',
    external_side_effect: '执行外部操作',
  } as const)[action ?? 'external_side_effect'];
}

function authorizationRiskLabel(risk: Extract<ProcessRow, { kind: 'authorization' }>['risk']) {
  return risk === 'high' ? '高风险' : risk === 'low' ? '低风险' : '需留意';
}

function ReasoningRow({ row, partnerName }: { row: ReasoningItem; partnerName: string }) {
  const label = row.state === 'running' ? partnerName + '正在思考…' : row.state === 'failure' ? '思考中断' : '想好了';
  if (!row.detail) return <div className={`timeline-reasoning timeline-reasoning--plain state-${row.state}`}><span>{label}</span>{row.state !== 'success' && <OutcomeIcon state={row.state} />}</div>;
  return <ReasoningDetails key={row.state} row={row} label={label} detail={row.detail} />;
}

function ReasoningDetails({ row, label, detail }: { row: ReasoningItem; label: string; detail: string }) {
  const [open, setOpen] = useState(false);
  return <details className={`timeline-reasoning timeline-reasoning--visible state-${row.state}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span>{label}</span>{row.state !== 'success' && <OutcomeIcon state={row.state} />}<ChevronDown size={12} /></summary>
    <div className="timeline-reasoning__body"><MarkdownContent>{detail}</MarkdownContent></div>
  </details>;
}

function OperationRow({ row, partnerName, onOpenArtifact }: { row: ActionRow; partnerName: string; onOpenArtifact: (artifactId: string) => void }) {
  const category = actionCategory(row);
  const presentation = actionPresentation(row);
  const meta = categoryMeta(category);
  const Icon = meta.icon;
  const fileNames = operationFileNames(row);
  const fileWriteKind = category === 'file_write' ? operationFileWriteKind(row) : undefined;
  const label = runtimeOperationLabel(category, presentation.semantic, row.state, partnerName, fileNames, fileWriteKind, operationDetailValue(row.detail, 'action'));
  const previewFile = row.files.length === 1 ? row.files[0] : undefined;
  return <div className={`timeline-operation timeline-operation--plain timeline-operation--${category} state-${row.state}`}>
    <Icon size={13} />
    {previewFile
      ? <button className="timeline-operation__label-button" type="button" onClick={() => onOpenArtifact(previewFile.artifactId)} title={`预览 ${previewFile.name}`}>{label}</button>
      : <span>{label}</span>}
    <OutcomeIcon state={row.state} />
    {row.files.length > 1 && <div className="timeline-operation__previews">{row.files.map((file) => <button className="timeline-operation__preview" key={file.artifactId} type="button" onClick={() => onOpenArtifact(file.artifactId)} title={`预览 ${file.name}`}>预览</button>)}</div>}
  </div>;
}

function actionPresentation(row: ActionItem) {
  return row.kind === 'computer' ? toolPresentation('computer') : toolPresentation(row.presentationName ?? row.toolName, operationDetailValue(row.detail, 'action'));
}

function actionCategory(row: ActionItem): TurnOperationCategory {
  return actionPresentation(row).category;
}

function categoryMeta(category: TurnOperationCategory) {
  return {
    tool: { label: '工具调用', icon: Wrench },
    command: { label: '命令运行', icon: TerminalSquare },
    mcp: { label: 'MCP 调用', icon: PlugZap },
    file_read: { label: '文件读取', icon: FileSearch },
    file_write: { label: '文件修改', icon: FilePenLine },
    web: { label: '网页操作', icon: Globe2 },
    computer: { label: '电脑操作', icon: MonitorCheck },
  }[category];
}

function buildTimelineBlocks(timeline: TurnTimelineItem[], delegationReceipts: DelegationReceipt[], completed: boolean): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  let pendingActions: Array<ActionItem | FileItem> = [];
  const authorizationToolIds = new Set(timeline.flatMap((item) => item.kind === 'authorization' && item.toolCallId ? [item.toolCallId] : []));
  const coalescedTimeline = coalesceActionEvents(timeline);
  const suppressedActionIds = new Set(coalescedTimeline.flatMap((item) => {
    if (item.kind !== 'tool') return [];
    const presentation = actionPresentation(item);
    if (presentation.mode === 'hidden' || presentation.mode === 'standalone_card') return [item.toolCallId];
    if (presentation.mode !== 'approval') return [];
    const action = operationDetailValue(item.detail, 'action');
    return (item.state === 'running' || (action !== 'add' && action !== 'remove') || authorizationToolIds.has(item.toolCallId)) ? [item.toolCallId] : [];
  }));
  const actionIds = new Set(coalescedTimeline.flatMap((item) => (item.kind === 'tool' || item.kind === 'computer') && !suppressedActionIds.has(item.toolCallId) ? [item.toolCallId] : []));
  const linkedFiles = new Map<string, FileItem[]>();
  for (const item of timeline) {
    if (item.kind !== 'file' || !item.toolCallId || !actionIds.has(item.toolCallId)) continue;
    linkedFiles.set(item.toolCallId, [...(linkedFiles.get(item.toolCallId) ?? []), item]);
  }
  const authorizationSummaries = new Set(
    timeline.filter((item) => item.kind === 'authorization').map((item) => item.summary.trim()),
  );
  const pendingAuthorizationToolIds = new Set(
    timeline.flatMap((item) => item.kind === 'authorization' && item.state === 'running' && item.toolCallId ? [item.toolCallId] : []),
  );

  const receiptsByCall = new Map(delegationReceipts.map(receipt => [receipt.requestId, receipt]));
  if (completed && delegationReceipts.length === 1) {
    // Some hosts retain a receipt without the tool call ID. Match only a unique dispatch in a finished turn.
    const dispatches = coalescedTimeline.filter(item => item.kind === 'tool' && actionPresentation(item).semantic === 'delegate_dispatch');
    const dispatch = dispatches[0];
    if (dispatches.length === 1 && dispatch.kind === 'tool' && dispatch.state === 'success') {
      receiptsByCall.set(dispatch.toolCallId, delegationReceipts[0]);
    }
  }
  const placedReceipts = new Set<string>();

  const flushActions = () => {
    if (!pendingActions.length) return;
    blocks.push({
      kind: 'actions',
      id: `actions-${pendingActions[0].id}`,
      rows: buildActionRows(pendingActions, linkedFiles),
    });
    pendingActions = [];
  };

  for (const item of coalescedTimeline) {
    if (item.kind === 'reasoning' && !item.detail) continue;
    if (item.kind === 'status' && /已完成回复[。.]?$/.test(item.summary)) continue;
    if (item.kind === 'status' && authorizationSummaries.has(item.summary.trim())) continue;
    if (item.kind === 'status' && /^(?:授权已确认，.+继续工作…|已拒绝授权，.+正在调整(?:方案)?…)$/.test(item.summary)) continue;
    if (item.kind === 'status' && item.state === 'success') continue;
    if (item.kind === 'file' && item.toolCallId && actionIds.has(item.toolCallId)) continue;
    if ((item.kind === 'tool' || item.kind === 'computer') && suppressedActionIds.has(item.toolCallId)) continue;
    if ((item.kind === 'tool' || item.kind === 'computer') && pendingAuthorizationToolIds.has(item.toolCallId)) continue;
    if (item.kind === 'tool' || item.kind === 'computer' || item.kind === 'file') {
      const receipt = item.kind === 'tool' && receiptsByCall.has(item.toolCallId)
        && actionPresentation(item).semantic === 'delegate_dispatch'
        ? receiptsByCall.get(item.toolCallId)
        : undefined;
      if (receipt) flushActions();
      pendingActions.push(item);
      if (receipt) {
        flushActions();
        blocks.push({ kind: 'delegation', receipt });
        placedReceipts.add(receipt.id);
      }
      continue;
    }
    flushActions();

    const previous = blocks.at(-1);
    if (item.kind === 'text') {
      if (previous?.kind === 'text') previous.text += item.text;
      else blocks.push({ kind: 'text', id: item.id, text: item.text });
      continue;
    }
    if (item.kind === 'reasoning') {
      if (previous?.kind === 'reasoning') {
        previous.row = {
          ...previous.row,
          state: item.state,
          detail: mergeDetail(previous.row.detail, item.detail),
        };
      } else blocks.push({ kind: 'reasoning', id: item.id, row: item });
      continue;
    }
    blocks.push({ kind: 'entry', id: item.id, row: item });
  }
  flushActions();
  const unplaced: TimelineBlock[] = delegationReceipts.filter(receipt => !placedReceipts.has(receipt.id))
    .map(receipt => ({ kind: 'delegation', receipt }));
  return [...unplaced, ...blocks];
}

function coalesceActionEvents(timeline: TurnTimelineItem[]) {
  const merged: TurnTimelineItem[] = [];
  const actionIndexes = new Map<string, number>();
  for (const item of timeline) {
    if (item.kind !== 'tool' && item.kind !== 'computer') {
      merged.push(item);
      continue;
    }
    const index = actionIndexes.get(item.toolCallId);
    if (index === undefined) {
      actionIndexes.set(item.toolCallId, merged.length);
      merged.push(item);
      continue;
    }
    const previous = merged[index];
    if (previous.kind !== 'tool' && previous.kind !== 'computer') continue;
    merged[index] = {
      ...previous,
      ...item,
      id: previous.id,
      sequence: previous.sequence,
      detail: mergedActionDetail(previous, item),
    } as TurnTimelineItem;
  }
  return merged;
}

function mergedActionDetail(previous: ActionItem, next: ActionItem) {
  const category = actionCategory(previous);
  const presentation = actionPresentation(previous);
  const keepPreviousFileReference = ['file_read', 'file_write'].includes(category)
    && fileNamesFromDetail(previous.detail).length > 0
    && fileNamesFromDetail(next.detail).length === 0;
  const actionDetail = ['notebook', 'task_contract', 'automation'].includes(presentation.semantic);
  if (keepPreviousFileReference || (presentation.preserveInputDetail && hasUsefulDetail(previous.detail)
    && (!actionDetail || operationDetailValue(previous.detail, 'action') !== undefined))) return previous.detail;
  return hasUsefulDetail(next.detail) ? next.detail : previous.detail;
}

function buildActionRows(items: Array<ActionItem | FileItem>, linkedFiles: Map<string, FileItem[]>): ActionClusterRow[] {
  const rows: ActionClusterRow[] = [];
  const actions = new Map<string, number>();
  for (const item of items) {
    if (item.kind === 'file') continue;
    const index = actions.get(item.toolCallId);
    if (index === undefined) {
      actions.set(item.toolCallId, rows.length);
      rows.push({ ...item, history: [item], files: [] });
      continue;
    }
    const current = rows[index];
    if (current.kind !== 'file') rows[index] = {
      ...current,
      ...item,
      id: current.id,
      sequence: current.sequence,
      history: [...current.history, item],
      files: current.files,
    };
  }
  for (const file of items.filter((item): item is FileItem => item.kind === 'file')) {
    const actionIndex = file.toolCallId ? actions.get(file.toolCallId) : undefined;
    const action = actionIndex === undefined ? undefined : rows[actionIndex];
    if (action && action.kind !== 'file') action.files.push(file);
    else rows.push(file);
  }
  for (const row of rows) {
    if (row.kind !== 'file') row.files.push(...(linkedFiles.get(row.toolCallId) ?? []).filter((file) => !row.files.some((current) => current.artifactId === file.artifactId)));
  }
  return rows;
}

function hasUsefulDetail(detail?: string) {
  return Boolean(detail && !/^(?:\{\}|\[\]|""|null)$/s.test(detail.trim()));
}

function operationFileNames(row: ActionRow) {
  const names = row.files.map((file) => file.name);
  const presentation = actionPresentation(row);
  if (!names.length && row.kind === 'tool' && (['file_read', 'file_write'].includes(actionCategory(row)) || presentation.semantic === 'delete')) {
    for (const event of row.history) names.push(...fileNamesFromDetail(event.detail));
  }
  return [...new Set(names)].slice(0, 4);
}

function operationFileWriteKind(row: ActionRow): 'create' | 'modify' | 'mixed' {
  const kinds = row.files.map((file) => file.changeKind).filter((kind): kind is 'create' | 'modify' => Boolean(kind));
  if (kinds.length && kinds.every((kind) => kind === 'create')) return 'create';
  if (kinds.includes('create') && kinds.includes('modify')) return 'mixed';
  if (kinds.includes('modify')) return 'modify';
  return row.kind === 'tool' && /^write$/i.test(row.toolName ?? '') ? 'create' : 'modify';
}

function fileNamesFromDetail(detail?: string) {
  if (!detail) return [];
  const candidates: string[] = [];
  try {
    collectFilePaths(JSON.parse(detail), candidates);
  } catch {
    for (const match of detail.matchAll(/(?:[A-Za-z]:[\\/]|\.\.?[\\/])[^\r\n"']+/g)) candidates.push(match[0]);
  }
  return candidates.map(fileName).filter(Boolean);
}

function collectFilePaths(value: unknown, output: string[]) {
  if (Array.isArray(value)) return value.forEach((item) => collectFilePaths(item, output));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /^(?:file_?path|path|notebook_?path)$/i.test(key)) output.push(item);
    else collectFilePaths(item, output);
  }
}

function fileName(value: string) {
  return value.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function runtimeOperationLabel(category: TurnOperationCategory, semantic: ToolSemantic, state: 'running' | 'success' | 'failure', partnerName: string, files: string[], fileWriteKind?: 'create' | 'modify' | 'mixed', workspaceAction?: string) {
  const subject = files.length === 1 ? files[0] : files.length > 1 ? `${files.length} 个文件` : '文件';
  const phrase = (running: string, success: string, failure: string) => `${partnerName}${state === 'running' ? running : state === 'failure' ? failure : success}`;
  if (semantic === 'notebook') return workspaceAction === 'list' || workspaceAction === 'read'
    ? phrase('正在翻看项目笔记…', '看完项目笔记了', '没能查看项目笔记')
    : workspaceAction === 'append' || workspaceAction === 'replace'
      ? phrase('正在整理项目笔记…', '把项目笔记整理好了', '没能整理好项目笔记') : genericToolLabel(state, partnerName);
  if (semantic === 'task_contract') {
    if (workspaceAction === 'context') return phrase('正在确认任务要求…', '确认好了任务要求', '没能确认任务要求');
    if (workspaceAction === 'submit_handoff') return phrase('正在提交任务成果…', '提交了任务成果', '没能提交任务成果');
    if (workspaceAction === 'submit_review') return phrase('正在提交复核结果…', '提交了复核结果', '没能提交复核结果');
    return genericToolLabel(state, partnerName);
  }
  if (semantic === 'automation') {
    const labels: Record<string, [string, string, string]> = {
      list: ['正在查看任务…', '看完任务了', '没能查看任务'],
      create: ['正在安排任务…', '把任务安排好了', '没能安排好任务'],
      update: ['正在调整任务…', '把任务调整好了', '没能调整好任务'],
      pause: ['正在暂停任务…', '暂停了任务', '没能暂停任务'],
      resume: ['正在重新启用任务…', '重新启用了任务', '没能重新启用任务'],
      remove: ['正在移除任务…', '移除了任务', '没能移除任务'],
    };
    const selected = labels[workspaceAction ?? ''];
    return selected ? phrase(...selected) : genericToolLabel(state, partnerName);
  }
  if (semantic === 'mcp_install') return phrase('正在登记并绑定 MCP…', '已登记并绑定 MCP', '没能登记 MCP');
  if (semantic === 'skill_run') return phrase('正在运行扩展能力脚本…', '运行完扩展能力脚本了', '没能运行扩展能力脚本');
  if (semantic === 'directory_list') return state === 'running' ? `${partnerName}正在看看目录…` : state === 'failure' ? `${partnerName}没能看完目录` : `${partnerName}看完目录了`;
  if (semantic === 'local_search') return state === 'running' ? `${partnerName}正在找本地文件…` : state === 'failure' ? `${partnerName}没找到相关文件` : `${partnerName}找到相关文件了`;
  if (semantic === 'delete') return state === 'running' ? `${partnerName}正在删除${files.length ? ` ${subject}` : ''}…` : state === 'failure' ? `${partnerName}没能删除${files.length ? ` ${subject}` : '这项内容'}` : `${partnerName}把${files.length ? ` ${subject} ` : '这项内容'}删掉了`;
  if (semantic === 'image_generation') return state === 'running' ? `${partnerName}正在画图…` : state === 'failure' ? `${partnerName}没能画完图片` : `${partnerName}把图片画好了`;
  if (semantic === 'collaboration') return state === 'running' ? `${partnerName}正在找小弟一起处理…` : state === 'failure' ? `${partnerName}和小弟没能处理完` : `${partnerName}和小弟一起处理好了`;
  if (semantic === 'delegate_dispatch') return phrase('正在派出小弟…', '派出小弟了', '没能派出小弟');
  if (semantic === 'delegate_wait') return phrase('正在等小弟汇报…', '结束了前台等待', '没能继续等待汇报');
  if (semantic === 'extension') return state === 'running' ? `${partnerName}正在使用扩展能力…` : state === 'failure' ? '扩展能力没有完成' : `${partnerName}使用扩展能力处理好了`;
  if (semantic === 'message_send') return state === 'running' ? `${partnerName}正在发送消息…` : state === 'failure' ? '消息没有发出去' : `${partnerName}把消息发出去了`;
  if (semantic === 'reminder_create') return state === 'running' ? `${partnerName}正在创建提醒…` : state === 'failure' ? '提醒没有创建成功' : `${partnerName}把提醒创建好了`;
  if (semantic === 'workspace') {
    if (workspaceAction === 'add') return state === 'running' ? `${partnerName}正在加入工作区…` : state === 'failure' ? `${partnerName}没能加入工作区` : `${partnerName}加入了工作区`;
    if (workspaceAction === 'remove') return state === 'running' ? `${partnerName}正在从工作区移除…` : state === 'failure' ? `${partnerName}没能从工作区移除` : `${partnerName}从工作区移除了`;
  }
  if (category === 'file_write' && fileWriteKind === 'create') return state === 'running' ? `${partnerName}正在埋头写 ${subject}…` : state === 'failure' ? `${partnerName}没能写完 ${subject}` : `${partnerName}把 ${subject} 写好了`;
  if (category === 'file_write' && fileWriteKind === 'mixed') return state === 'running' ? `${partnerName}正在处理 ${subject}…` : state === 'failure' ? `${partnerName}没能处理完 ${subject}` : `${partnerName}处理完了 ${subject}`;
  if (category === 'file_write') return state === 'running' ? `${partnerName}正在整理 ${subject}…` : state === 'failure' ? `${partnerName}没能修改 ${subject}` : `${partnerName}把 ${subject} 重新整理好了`;
  if (category === 'file_read') return state === 'running' ? `${partnerName}正在翻看 ${subject}…` : state === 'failure' ? `${partnerName}没能查看 ${subject}` : `${partnerName}看完 ${subject} 了`;
  if (category === 'web' || semantic === 'web') return state === 'running' ? `${partnerName}正在上网冲浪…` : state === 'failure' ? '没有找到需要的资料' : `${partnerName}冲浪回来了`;
  if (category === 'command' || category === 'computer') return state === 'running' ? `${partnerName}正在电脑里捣鼓…` : state === 'failure' ? '电脑操作没有完成' : `${partnerName}从电脑里忙完回来了`;
  if (category === 'mcp') return genericToolLabel(state, partnerName);
  return state === 'running' ? '正在处理…' : state === 'failure' ? '没有处理好' : '处理好了';
}

function genericToolLabel(state: 'running' | 'success' | 'failure', partnerName: string) {
  return state === 'running' ? `${partnerName}正在使用工具…` : state === 'failure' ? '工具使用失败' : '工具使用完成';
}

function operationDetailValue(detail: string | undefined, key: string) {
  if (!detail) return undefined;
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (typeof parsed[key] === 'string') return parsed[key];
    // Codex native item events wrap their input; Claude/API tools use a flat object.
    for (const field of ['arguments', 'input']) {
      const value = typeof parsed[field] === 'string' ? JSON.parse(parsed[field]) : parsed[field];
      if (value && typeof value === 'object' && typeof value[key] === 'string') return value[key];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function authorizationLocations(detail?: string, targets?: string[]) {
  const locations = [...(targets ?? [])];
  if (detail) {
    try {
      collectFilePaths(JSON.parse(detail), locations);
    } catch {
      const trimmed = detail.trim();
      if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('./') || trimmed.startsWith('../')) locations.push(trimmed);
    }
  }
  return [...new Set(locations.map((item) => item.trim()).filter(Boolean))];
}

function friendlyErrorLabel(summary: string, partnerName: string) {
  const friendly = friendlyRuntimeErrorMessage(summary);
  if (friendly !== summary) return friendly;
  if (summary === 'DeepSeek API Key 无效或没有访问权限。') return 'API 密钥无效';
  if (/process exited|unknown option|stderr|transport|连接|断开/i.test(summary)) return `${partnerName}连接中断`;
  if (/权限|permission|denied|forbidden/i.test(summary)) return '操作被权限规则阻止';
  return '这次任务没有完成';
}

function friendlyStatusLabel(summary: string, state: 'running' | 'success' | 'failure', partnerName: string) {
  if (/用户.*停止|已停止|取消/.test(summary)) return '已由用户停止';
  const namedSummary = partnerStatusLabel(summary, partnerName);
  if (state === 'running' && namedSummary !== summary) return namedSummary;
  if (/重试|retry/i.test(summary)) return `${partnerName}换个办法再试试…`;
  if (state === 'failure') return '这一步没弄成';
  return state === 'running' ? `${partnerName}正在忙这一步…` : `${partnerName}这一步搞定了`;
}

function mergeDetail(previous?: string, next?: string) {
  if (!next) return previous;
  if (!previous) return next;
  if (previous.endsWith(next)) return previous;
  if (next.startsWith(previous)) return next;
  return previous + next;
}
