import type { ProtocolError } from '../../shared/agentProtocol';
import { MarkdownArtifactParser } from './markdownArtifactParser';

export type ClaudeMappedEvent =
  | { type: 'message.accepted' }
  | { type: 'extension.event'; namespace: string; name: string; schemaVersion: number; payload: Record<string, unknown> }
  | { type: 'text.delta'; text: string }
  | { type: 'work.status'; state: 'thinking' | 'working' | 'waiting_authorization' | 'waiting_user_input' | 'idle'; summary: string; detail?: string }
  | { type: 'tool.started'; toolCallId: string; toolName: string; summary: string; mutatesExternalState: boolean; detail?: string }
  | { type: 'tool.progress'; toolCallId: string; summary: string; detail?: string }
  | { type: 'tool.completed'; toolCallId: string; outcome: 'success' | 'failure'; summary: string; detail?: string }
  | { type: 'file.produced'; artifactId: string; toolCallId?: string; name: string; artifactRef: string; mediaType?: string; source?: import('../../shared/agentProtocol').ArtifactSourceClaim; registrationMethod?: 'automatic' | 'deliver_tool' | 'message_image'; changeKind?: 'create' | 'modify' }
  | { type: 'authorization.requested'; authorizationId: string; toolCallId?: string; action: 'read_file' | 'write_file' | 'delete_file' | 'run_command' | 'computer_control' | 'external_side_effect'; risk: 'low' | 'medium' | 'high'; summary: string; targets: string[]; resolution?: 'interactive' | 'display_only'; purpose?: import('../../shared/agentProtocol').AuthorizationPurpose }
  | { type: 'authorization.resolved'; authorizationId: string; decision: 'allow_once' | 'deny' }
  | { type: 'user_input.requested'; requestId: string; questions: import('../../shared/agentProtocol').UserInputQuestion[] }
  | { type: 'user_input.resolved'; requestId: string; answers: Record<string, string[]>; customAnswers?: Record<string, string> }
  | { type: 'plan.updated'; status: 'planning' | 'waiting_user' | 'ready' | 'executing' | 'completed'; planMode?: 'default' | 'plan'; explanation?: string }
  | { type: 'run.completed'; finishReason: 'completed' | 'end_turn' }
  | { type: 'run.failed'; error: ProtocolError }
  | { type: 'run.cancelled'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecordArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function mutatesExternalState(toolName: string) {
  return /^(Write|Edit|MultiEdit|NotebookEdit|Bash|Computer|mcp__)/i.test(toolName);
}

function displayTool(toolName: string) {
  const labels: Record<string, string> = {
    Read: '读取文件', Glob: '查找文件', Grep: '搜索内容', Write: '写入文件', Edit: '修改文件', Bash: '运行命令', WebSearch: '搜索网络', WebFetch: '读取网页', Task: '调用子任务', Skill: '使用 Skill', Computer: '操作电脑',
  };
  if (toolName.startsWith('mcp__')) return `调用 MCP ${toolName.split('__')[1] ?? toolName}`;
  return labels[toolName] ?? `使用 ${toolName}`;
}

function safeMessage(value: unknown, fallback: string) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function toolResultMessage(value: unknown) {
  if (typeof value === 'string') return safeMessage(value, '');
  const texts = asRecordArray(value).map((item) => typeof item.text === 'string' ? item.text : '').filter(Boolean);
  return safeMessage(texts.join(' '), '');
}

export class ClaudeStreamParser {
  private accepted = false;
  private streamedText = false;
  private thinkingPhase = 0;
  private readonly tools = new Map<string, { name: string; input?: Record<string, unknown> }>();
  private readonly markdownImages = new MarkdownArtifactParser();
  private imageCounter = 0;

  parseLine(line: string): ClaudeMappedEvent[] {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isRecord(message)) return [];

    const mapped: ClaudeMappedEvent[] = [];
    if (message.type === 'system' && message.subtype === 'init' && !this.accepted) {
      this.accepted = true;
      if (typeof message.model === 'string' && message.model.trim()) mapped.push({
        type: 'extension.event', namespace: 'asterium.runtime', name: 'model_observed', schemaVersion: 1,
        payload: { model: message.model.trim(), source: 'native_thread' },
      });
      mapped.push({ type: 'message.accepted' });
      return mapped;
    }

    if (message.type === 'stream_event' && isRecord(message.event)) {
      const event = message.event;
      if (event.type === 'content_block_start' && isRecord(event.content_block)) {
        const block = event.content_block;
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          this.tools.set(block.id, { name: block.name, input: isRecord(block.input) ? block.input : undefined });
          mapped.push({
            type: 'tool.started',
            toolCallId: block.id,
            toolName: block.name,
            summary: `${displayTool(block.name)}…`,
            mutatesExternalState: mutatesExternalState(block.name),
            detail: safeDetail(block.input),
          });
        } else if (block.type === 'thinking') {
          this.thinkingPhase += 1;
          mapped.push({ type: 'work.status', state: 'thinking', summary: this.thinkingPhase === 1 ? '本地伙伴正在思考…' : `本地伙伴进入第 ${this.thinkingPhase} 段思考…` });
        }
      } else if (event.type === 'content_block_delta' && isRecord(event.delta)) {
        if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
          this.streamedText = true;
          mapped.push(...this.mapText(event.delta.text));
        } else if (event.delta.type === 'input_json_delta') {
          const currentTool = [...this.tools.entries()].at(-1);
          if (currentTool) mapped.push({ type: 'tool.progress', toolCallId: currentTool[0], summary: '正在准备工具参数…' });
        } else if (event.delta.type === 'thinking_delta') {
          if (this.thinkingPhase === 0) this.thinkingPhase = 1;
          mapped.push({
            type: 'work.status',
            state: 'thinking',
            summary: this.thinkingPhase === 1 ? '本地伙伴正在思考…' : `本地伙伴进入第 ${this.thinkingPhase} 段思考…`,
            detail: typeof event.delta.thinking === 'string' ? event.delta.thinking : undefined,
          });
        }
      }
      return mapped;
    }

    if (message.type === 'assistant' && isRecord(message.message)) {
      for (const block of asRecordArray(message.message.content)) {
        if (block.type === 'text' && typeof block.text === 'string' && !this.streamedText) {
          mapped.push(...this.mapText(block.text));
        }
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          const known = this.tools.get(block.id);
          this.tools.set(block.id, { name: block.name, input: isRecord(block.input) ? block.input : known?.input });
          if (known && isRecord(block.input)) mapped.push({ type: 'tool.progress', toolCallId: block.id, summary: `${displayTool(block.name)}…`, detail: safeDetail(block.input) });
          if (!known) mapped.push({
            type: 'tool.started',
            toolCallId: block.id,
            toolName: block.name,
            summary: `${displayTool(block.name)}…`,
            mutatesExternalState: mutatesExternalState(block.name),
            detail: safeDetail(block.input),
          });
        }
      }
      return mapped;
    }

    if (message.type === 'user' && isRecord(message.message)) {
      for (const block of asRecordArray(message.message.content)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const tool = this.tools.get(block.tool_use_id);
        const failed = block.is_error === true;
        const detail = failed ? toolResultMessage(block.content) : '';
        mapped.push({
          type: 'tool.completed',
          toolCallId: block.tool_use_id,
          outcome: failed ? 'failure' : 'success',
          summary: failed ? `${tool ? displayTool(tool.name) : '工具'}失败${detail ? `：${detail}` : ''}` : `${tool ? displayTool(tool.name) : '工具'}完成`,
          detail: safeDetail(block.content),
        });
        if (!failed && tool && (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(tool.name) || /(?:^|__)deliver_file$/i.test(tool.name))) {
          const path = tool.input?.file_path ?? tool.input?.path ?? tool.input?.notebook_path;
          if (typeof path === 'string' && path.trim()) {
            mapped.push({
              type: 'file.produced',
              artifactId: `claude-file-${block.tool_use_id}`,
              toolCallId: block.tool_use_id,
              name: path.replace(/\\/g, '/').split('/').at(-1) ?? '文件',
              artifactRef: path,
              registrationMethod: /deliver_file$/i.test(tool.name) ? 'deliver_tool' : 'automatic',
              ...(/^(Write)$/i.test(tool.name) ? { changeKind: 'create' as const } : /^(Edit|MultiEdit|NotebookEdit)$/i.test(tool.name) ? { changeKind: 'modify' as const } : {}),
            });
          }
        }
      }
      return mapped;
    }

    if (message.type === 'result') {
      if (message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success')) {
        mapped.push({
          type: 'run.failed',
          error: {
            code: typeof message.subtype === 'string' ? message.subtype.toUpperCase() : 'CLAUDE_RESULT_ERROR',
            message: safeMessage(message.result, 'Claude Code 未能完成这次任务。'),
            stage: 'adapter',
            retryable: true,
            technicalDetail: safeDetail(message),
          },
        });
      } else {
        mapped.push({ type: 'run.completed', finishReason: 'end_turn' });
      }
    }
    return mapped;
  }

  private mapText(value: string): ClaudeMappedEvent[] {
    const parsed = this.markdownImages.push(value);
    return [
      ...(parsed.text ? [{ type: 'text.delta' as const, text: parsed.text }] : []),
      ...parsed.claims.map((claim) => ({ type: 'file.produced' as const, artifactId: `claude-message-image-${++this.imageCounter}`, name: claim.name, artifactRef: 'registry-pending', mediaType: claim.mediaType, source: claim.source, registrationMethod: 'message_image' as const })),
    ];
  }
}

function safeDetail(value: unknown) {
  if (value === undefined) return undefined;
  try {
    const safe = redact(value);
    if ((Array.isArray(safe) && safe.length === 0) || (isRecord(safe) && Object.keys(safe).length === 0)) return undefined;
    const detail = JSON.stringify(safe, null, 2);
    return /^(?:\{\}|\[\]|""|null)$/s.test(detail.trim()) ? undefined : detail.slice(0, 32_768);
  } catch {
    return undefined;
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|cookie|authorization|api.?key/i.test(key) ? '[已隐藏]' : redact(item)]));
}
