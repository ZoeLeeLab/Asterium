import { describe, expect, it } from 'vitest';
import {
  CodexEventMapper,
  approvalResponse,
  mapCodexApprovalRequest,
} from '../../src/main/adapters/codexAppServerProtocol';

describe('Codex app-server protocol mapping', () => {
  it('maps streamed text and preserves reasoning summaries for expansion', () => {
    const mapper = new CodexEventMapper();
    const events = [
      ...mapper.map({ method: 'turn/started', params: { turn: { id: 'turn-1' } } }),
      ...mapper.map({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'reason-1', summaryIndex: 0, delta: '可展示的思考摘要' } }),
      ...mapper.map({ method: 'item/reasoning/summaryPartAdded', params: { itemId: 'reason-1', summaryIndex: 1 } }),
      ...mapper.map({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'reason-1', summaryIndex: 1, delta: '第二段可展示摘要' } }),
      ...mapper.map({ method: 'item/reasoning/textDelta', params: { itemId: 'reason-1', contentIndex: 0, delta: 'private reasoning' } }),
      ...mapper.map({ method: 'item/agentMessage/delta', params: { itemId: 'message-1', delta: '你好，用户' } }),
      ...mapper.map({ method: 'item/completed', params: { item: { id: 'message-1', type: 'agentMessage', text: '你好，用户' } } }),
      ...mapper.map({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }),
    ];

    expect(events).toContainEqual({ type: 'text.delta', text: '你好，用户' });
    expect(events.filter((event) => event.type === 'text.delta')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', finishReason: 'end_turn' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'work.status', state: 'thinking', detail: '可展示的思考摘要' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'work.status', summary: 'Codex 思考摘要 2', detail: '第二段可展示摘要' }));
    expect(JSON.stringify(events)).not.toContain('private reasoning');
  });

  it('does not render userMessage input as a tool operation', () => {
    const mapper = new CodexEventMapper();
    expect(mapper.map({ method: 'item/started', params: { item: { id: 'user-1', type: 'userMessage', text: 'hello' } } })).toEqual([]);
    expect(mapper.map({ method: 'item/completed', params: { item: { id: 'user-1', type: 'userMessage', text: 'hello' } } })).toEqual([]);
  });

  it('maps command and file lifecycle events including produced artifacts', () => {
    const mapper = new CodexEventMapper();
    const events = [
      ...mapper.map({ method: 'item/started', params: { item: { id: 'command-1', type: 'commandExecution', command: 'npm test', status: 'inProgress' } } }),
      ...mapper.map({ method: 'item/completed', params: { item: { id: 'command-1', type: 'commandExecution', command: 'npm test', status: 'completed' } } }),
      ...mapper.map({ method: 'item/started', params: { item: { id: 'file-1', type: 'fileChange', status: 'inProgress', changes: [] } } }),
      ...mapper.map({ method: 'item/completed', params: { item: { id: 'file-1', type: 'fileChange', status: 'completed', changes: [{ path: 'K:\\qa\\result.md', kind: 'add' }] } } }),
    ];

    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.started', toolCallId: 'command-1', toolName: 'commandExecution' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', toolCallId: 'command-1', outcome: 'success' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'file.produced', toolCallId: 'file-1', name: 'result.md', artifactRef: 'K:\\qa\\result.md', changeKind: 'create' }));
  });

  it('bridges current and legacy approvals as allow-once or deny', () => {
    const modern = mapCodexApprovalRequest({
      id: 17,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', command: ['npm', 'test'], cwd: 'K:\\qa' },
    });
    const legacy = mapCodexApprovalRequest({
      id: 18,
      method: 'applyPatchApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', grantRoot: 'K:\\qa' },
    });

    expect(modern?.event).toMatchObject({ action: 'run_command', risk: 'high', targets: ['K:\\qa'] });
    expect(approvalResponse(modern!, 'allow_once')).toEqual({ decision: 'accept' });
    expect(approvalResponse(modern!, 'deny')).toEqual({ decision: 'decline' });
    expect(approvalResponse(legacy!, 'allow_once')).toEqual({ decision: 'approved' });
    expect(approvalResponse(legacy!, 'deny')).toEqual({ decision: 'denied' });

    const permission = mapCodexApprovalRequest({
      id: 19,
      method: 'item/permissions/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'permission-1', cwd: 'K:\\qa', permissions: { network: { enabled: true }, fileSystem: { write: ['K:\\outside'] } } },
    });
    expect(permission?.event).toMatchObject({ action: 'external_side_effect', risk: 'high', targets: ['K:\\qa', 'K:\\outside'] });
    expect(approvalResponse(permission!, 'allow_once')).toEqual({ permissions: { network: { enabled: true }, fileSystem: { write: ['K:\\outside'] } }, scope: 'turn' });
    expect(approvalResponse(permission!, 'deny')).toEqual({ permissions: {}, scope: 'turn' });

    const nullablePermission = mapCodexApprovalRequest({
      id: 20,
      method: 'item/permissions/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'permission-2', permissions: { network: null, fileSystem: { write: ['K:\\outside'] } } },
    });
    expect(approvalResponse(nullablePermission!, 'allow_once')).toEqual({ permissions: { fileSystem: { write: ['K:\\outside'] } }, scope: 'turn' });
  });

  it('maps MCP tools and retrying transport errors without leaking error internals', () => {
    const mapper = new CodexEventMapper();
    const events = [
      ...mapper.map({ method: 'item/started', params: { item: { id: 'mcp-1', type: 'mcpToolCall', server: 'memory', tool: 'search', status: 'inProgress' } } }),
      ...mapper.map({ method: 'item/mcpToolCall/progress', params: { itemId: 'mcp-1', message: '正在检索' } }),
      ...mapper.map({ method: 'item/completed', params: { item: { id: 'mcp-1', type: 'mcpToolCall', server: 'memory', tool: 'search', status: 'completed' } } }),
      ...mapper.map({ method: 'error', params: { willRetry: true, error: { message: '连接超时', privateDetail: 'secret' } } }),
    ];

    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.started', toolName: 'mcp__memory__search' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.progress', summary: '正在检索' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'work.status', summary: expect.stringContaining('正在重试') }));
    expect(JSON.stringify(events)).not.toContain('privateDetail');
  });

  it('maps interrupted and failed turns to terminal protocol events', () => {
    const interrupted = new CodexEventMapper().map({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } }, '用户主动停止');
    const failed = new CodexEventMapper().map({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'model unavailable' } } } });

    expect(interrupted.at(-1)).toEqual({ type: 'run.cancelled', reason: '用户主动停止' });
    expect(failed).toContainEqual(expect.objectContaining({ type: 'run.failed', error: expect.objectContaining({ code: 'CODEX_TURN_FAILED', message: 'model unavailable' }) }));
  });
});
