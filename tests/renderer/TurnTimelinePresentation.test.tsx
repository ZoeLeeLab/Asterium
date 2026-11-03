import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TurnTimeline } from '../../src/renderer/components/chat/TurnTimeline';
import type { Message } from '../../src/renderer/types/domain';
import { prototypeReducer } from '../../src/renderer/app/PrototypeProvider';
import { createTestState } from '../fixtures/applicationState';
import type { PartnerEvent } from '../../src/shared/agentProtocol';

const baseMessage: Message = {
  id: 'assistant-1',
  authorId: 'partner-1',
  content: '',
  createdAt: '10:00',
  runId: 'run-1',
};

describe('user-facing runtime presentation', () => {
  it('clearly distinguishes one-command Native approval from ordinary permission or persistent trust', () => {
    const resolve = vi.fn();
    render(<TurnTimeline message={{ ...baseMessage, timeline: [{ id: 'native', sequence: 1, kind: 'authorization', authorizationId: 'native-auth', toolCallId: 'call', action: 'run_command', purpose: 'command_native', risk: 'high', state: 'running', summary: '仅本次 Native', detail: 'Write-Output OK\ncwd: C:\\fixture' }] }}
      pendingAuthorization={{ authorizationId: 'native-auth', toolCallId: 'call', action: 'run_command', purpose: 'command_native', risk: 'high', summary: '仅本次 Native', targets: ['Write-Output OK', 'cwd: C:\\fixture'] }}
      partnerName="测试伙伴" onResolveAuthorization={resolve} onResolveUserInput={vi.fn()} onOpenArtifact={vi.fn()} />);
    expect(screen.getByText(/本次进程不受沙箱工作区和联网开关限制/)).toBeInTheDocument();
    expect(screen.getByText(/Write-Output OK/).textContent).toBe('Write-Output OK\ncwd: C:\\fixture');
    expect(screen.queryByRole('button', { name: /持续信任/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '仅本次无沙箱运行' }));
    expect(resolve).toHaveBeenCalledWith('allow_once');
  });
  it('uses native wrapped arguments and late Claude input to distinguish task and automation actions', () => {
    render(<TurnTimeline message={{ ...baseMessage, timeline: [
      { id: 'codex', sequence: 1, kind: 'tool', toolCallId: 'codex', toolName: 'asterium_task', summary: 'native item', state: 'success', detail: '{"type":"dynamicToolCall","arguments":"{\\"action\\":\\"submit_review\\"}"}' },
      { id: 'claude-start', sequence: 2, kind: 'tool', toolCallId: 'claude', toolName: 'mcp__asterium__asterium_automation', summary: 'start', state: 'running', detail: '{}' },
      { id: 'claude-progress', sequence: 3, kind: 'tool', toolCallId: 'claude', toolName: 'mcp__asterium__asterium_automation', summary: 'input', state: 'running', detail: '{"action":"pause"}' },
      { id: 'claude-end', sequence: 4, kind: 'tool', toolCallId: 'claude', toolName: 'mcp__asterium__asterium_automation', summary: 'output', state: 'success', detail: '{"saved":true}' },
    ] }} partnerName="本地伙伴" onResolveAuthorization={vi.fn()} onResolveUserInput={vi.fn()} onOpenArtifact={vi.fn()} />);
    expect(screen.getByText('本地伙伴提交了复核结果')).toBeInTheDocument();
    expect(screen.getByText('本地伙伴暂停了任务')).toBeInTheDocument();
  });
  it('retains a dynamic MCP action across progress, completion and reload without exposing its encoded execution name', () => {
    let state = createTestState();
    const conversation = { ...state.conversations[0], partnerId: 'fixture-api' };
    state.conversations = state.conversations.map(item => item.id === conversation.id ? { ...conversation, sessionId: 's', activeRun: { runId: 'classification', clientMessageId: 'classification' } } : item);
    const base = { protocolVersion: 2 as const, partnerId: conversation.partnerId, conversationId: conversation.id, connectionSource: 'api_partner' as const, clientMessageId: 'classification', sessionId: 's', runId: 'classification', occurredAt: new Date().toISOString() };
    const events: PartnerEvent[] = [
      { ...base, eventId: 'start', sequence: 1, type: 'tool.started', toolCallId: 'dynamic', toolName: 'mcp_aabb_ccdd', presentationName: 'mcp__fixture__project_notebook', summary: 'raw summary', mutatesExternalState: true, detail: '{"action":"append","content":"private notebook body"}' },
      { ...base, eventId: 'progress', sequence: 2, type: 'tool.progress', toolCallId: 'dynamic', summary: 'progress' },
      { ...base, eventId: 'end', sequence: 3, type: 'tool.completed', toolCallId: 'dynamic', outcome: 'success', summary: 'completed', detail: '{"action":"read","content":"different result"}' },
    ];
    for (const event of events) state = prototypeReducer(state, { type: 'agentEvent', event });
    const message = JSON.parse(JSON.stringify(state.conversations.find(item => item.id === conversation.id)!.messages.find(item => item.runId === 'classification'))) as Message;
    expect(message.timeline?.filter(item => item.kind === 'tool').every(item => item.presentationName === 'mcp__fixture__project_notebook')).toBe(true);
    render(<TurnTimeline message={message} partnerName="本地伙伴" onResolveAuthorization={vi.fn()} onResolveUserInput={vi.fn()} onOpenArtifact={vi.fn()} />);
    expect(screen.getByText('本地伙伴把项目笔记整理好了')).toBeInTheDocument();
    expect(screen.queryByText(/private notebook body|different result|raw summary|mcp_aabb_ccdd|找外援|找的外援/)).not.toBeInTheDocument();
  });

  it('unifies hidden tools across direct, native MCP and dynamic API calls while preserving approval cards', () => {
    const hiddenNames = ['hold_memory', 'search_memory', 'comment_memory', 'update_memory', 'read_memory_source', 'submit_workflow_draft', 'asterium_mcp_list', 'skill_read'];
    const timeline: NonNullable<Message['timeline']> = hiddenNames.flatMap((name, index) => [
      { id: `direct-${index}`, sequence: index * 3 + 1, kind: 'tool' as const, toolCallId: `direct-${index}`, toolName: name, summary: 'hidden raw tool', state: 'success' as const },
      { id: `native-${index}`, sequence: index * 3 + 2, kind: 'tool' as const, toolCallId: `native-${index}`, toolName: `mcp__asterium__${name}`, summary: 'hidden raw tool', state: 'failure' as const },
      { id: `dynamic-${index}`, sequence: index * 3 + 3, kind: 'tool' as const, toolCallId: `dynamic-${index}`, toolName: 'mcp_encoded_method', presentationName: `mcp__fixture__${name}`, summary: 'hidden raw tool', state: 'running' as const },
    ]);
    timeline.push({ id: 'report', sequence: 30, kind: 'tool', toolCallId: 'report', toolName: 'asterium_automation', summary: 'internal report', state: 'success', detail: '{"action":"report","changed":false}' });
    const pending = { authorizationId: 'approval', toolCallId: 'dynamic-0', action: 'external_side_effect' as const, risk: 'high' as const, summary: '仍需用户确认的外部操作', targets: [] };
    timeline.push({ id: 'approval', sequence: 31, kind: 'authorization', ...pending, state: 'running' });
    const resolve = vi.fn();
    render(<TurnTimeline message={{ ...baseMessage, timeline }} partnerName="本地伙伴" pendingAuthorization={pending} onResolveAuthorization={resolve} onResolveUserInput={vi.fn()} onOpenArtifact={vi.fn()} />);
    expect(screen.queryByText(/hidden raw tool|internal report|正在使用工具|工具使用完成|工具使用失败|正在处理/)).not.toBeInTheDocument();
    expect(screen.getByText('需要你的确认')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    expect(resolve).toHaveBeenCalledWith('allow_once');
  });
  it('requires an explicit persistent choice on an offered MCP approval, keeping allow_once distinct', () => {
    const resolve = vi.fn();
    const pending = { authorizationId: 'mcp-auth', action: 'external_side_effect' as const, risk: 'high' as const, summary: '调用测试 MCP', targets: ['Fixture'], extensionTrust: { extensionId: 'extension-1', name: 'Fixture', generation: 3 } };
    const props = { message: { ...baseMessage, timeline: [{ id: 'mcp', sequence: 1, kind: 'authorization' as const, ...pending, state: 'running' as const }] }, partnerName: 'API 伙伴', pendingAuthorization: pending, onResolveAuthorization: resolve, onResolveUserInput: vi.fn(), onOpenArtifact: vi.fn() };
    const { rerender } = render(<TurnTimeline {...props} />);
    expect(screen.getByText(/只读和 Plan 仍禁止执行/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    expect(resolve).toHaveBeenLastCalledWith('allow_once');
    fireEvent.click(screen.getByRole('button', { name: '允许并持续信任此 MCP' }));
    expect(resolve).toHaveBeenLastCalledWith('allow_once', true);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(resolve).toHaveBeenLastCalledWith('deny');
    rerender(<TurnTimeline {...props} pendingAuthorization={{ ...pending, extensionTrust: undefined }} />);
    expect(screen.queryByRole('button', { name: '允许并持续信任此 MCP' })).not.toBeInTheDocument();
  });

  it('labels persistent Skill approval with its script-only scope', () => {
    const resolve = vi.fn();
    const pending = { authorizationId: 'skill-auth', action: 'run_command' as const, risk: 'high' as const, summary: '执行 Skill 脚本', targets: ['scripts/main.mjs'], extensionTrust: { kind: 'skill' as const, extensionId: 'skill-1', name: 'Fixture', generation: 3 } };
    render(<TurnTimeline message={{ ...baseMessage, timeline: [{ id: 'skill', sequence: 1, kind: 'authorization', ...pending, state: 'running' }] }} partnerName="API" pendingAuthorization={pending} onResolveAuthorization={resolve} onResolveUserInput={vi.fn()} onOpenArtifact={vi.fn()} />);
    expect(screen.getByText(/仅此技能包的脚本/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '允许并持续信任此 MCP' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '允许一次' })); expect(resolve).toHaveBeenLastCalledWith('allow_once');
    fireEvent.click(screen.getByRole('button', { name: '允许并持续信任此 Skill' })); expect(resolve).toHaveBeenLastCalledWith('allow_once', true);
  });

  it('offers selected assistant body text to the quote menu only inside one text segment', () => {
    const onQuoteSelection = vi.fn();
    render(<TurnTimeline
      message={{ ...baseMessage, runState: 'completed', timeline: [
        { id: 'text', sequence: 1, kind: 'text', text: '可以引用的正文片段' },
        { id: 'reasoning', sequence: 2, kind: 'reasoning', summary: '想好了', state: 'success', detail: '不可引用的思考' },
      ] }}
      partnerName="测试助手"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
      onQuoteSelection={onQuoteSelection}
    />);

    const text = screen.getByText('可以引用的正文片段');
    const textNode = text.firstChild!;
    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, anchorNode: textNode, focusNode: textNode, toString: () => '引用的正文' } as unknown as Selection);
    fireEvent.contextMenu(text);
    expect(onQuoteSelection).toHaveBeenCalledWith('引用的正文', 0, 0);

    const reasoningNode = screen.getByText('想好了').firstChild!;
    getSelection.mockReturnValue({ isCollapsed: false, anchorNode: textNode, focusNode: reasoningNode, toString: () => '跨区选中' } as unknown as Selection);
    fireEvent.contextMenu(text);
    expect(onQuoteSelection).toHaveBeenCalledTimes(1);
    getSelection.mockRestore();
  });

  it('keeps readable reasoning text visible while hiding machine details elsewhere', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'reasoning', sequence: 1, kind: 'reasoning', summary: '正在思考', state: 'success', detail: '先检查项目结构，再整理 **交付文件**。' },
        ],
      }}
      partnerName="本地伙伴"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    const reasoningSummary = screen.getByText('想好了').closest('summary');
    const reasoningDetails = reasoningSummary?.closest('details');
    expect(reasoningDetails).not.toHaveAttribute('open');
    expect(reasoningSummary?.querySelector('.timeline-outcome')).toBeNull();
    fireEvent.click(reasoningSummary!);
    expect(reasoningDetails).toHaveAttribute('open');
    expect(screen.getByText(/先检查项目结构/)).toBeInTheDocument();
    expect(screen.getByText('交付文件')).toBeInTheDocument();
  });

  it('keeps an in-progress reasoning summary collapsed until the user opens it', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'reasoning-running', sequence: 1, kind: 'reasoning', summary: '正在思考', state: 'running', detail: '正在检查项目结构。' },
        ],
      }}
      partnerName="本地伙伴"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    const reasoningSummary = screen.getByText('本地伙伴正在思考…').closest('summary');
    const reasoningDetails = reasoningSummary?.closest('details');
    expect(reasoningDetails).not.toHaveAttribute('open');
    fireEvent.click(reasoningSummary!);
    expect(reasoningDetails).toHaveAttribute('open');
    expect(screen.getByText('正在检查项目结构。')).toBeInTheDocument();
  });

  it('turns file tool logs into one friendly, previewable operation', () => {
    const onOpenArtifact = vi.fn();
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'tool-start', sequence: 1, kind: 'tool', toolCallId: 'write-1', toolName: 'Edit', category: 'file_write', summary: '写入文件…', state: 'running', detail: '{"file_path":"K:\\\\workspace\\\\report.md","content":"raw source"}' },
          { id: 'tool-end', sequence: 2, kind: 'tool', toolCallId: 'write-1', toolName: 'Edit', category: 'file_write', summary: '写入文件完成', state: 'success', detail: 'internal tool output' },
          { id: 'file', sequence: 3, kind: 'file', toolCallId: 'write-1', artifactId: 'artifact-1', name: 'report.md', summary: '产出文件：report.md', state: 'success' },
        ],
      }}
      partnerName="本地伙伴"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={onOpenArtifact}
    />);

    expect(screen.getByText('本地伙伴把 report.md 重新整理好了')).toBeInTheDocument();
    expect(screen.queryByText(/raw source|internal tool output/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '本地伙伴把 report.md 重新整理好了' }));
    expect(onOpenArtifact).toHaveBeenCalledWith('artifact-1');
  });

  it('distinguishes a newly created file from an edited file', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'tool', sequence: 1, kind: 'tool', toolCallId: 'write-2', toolName: 'fileChange', category: 'file_write', summary: '写入文件完成', state: 'success' },
          { id: 'file', sequence: 2, kind: 'file', toolCallId: 'write-2', artifactId: 'artifact-2', name: 'new-report.md', summary: '产出文件：new-report.md', state: 'success', changeKind: 'create' },
        ],
      }}
      partnerName="测试助手"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    expect(screen.getByText('测试助手把 new-report.md 写好了')).toBeInTheDocument();
    expect(screen.queryByText(/已修改 new-report\.md/)).not.toBeInTheDocument();
  });

  it('keeps the file name from the start event after a read completes', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'read-start', sequence: 1, kind: 'tool', toolCallId: 'read-1', toolName: 'Read', category: 'file_read', summary: '正在读取文件', state: 'running', detail: '{"path":"K:\\\\workspace\\\\package.json"}' },
          { id: 'read-end', sequence: 2, kind: 'tool', toolCallId: 'read-1', toolName: 'Read', category: 'file_read', summary: '读取完成', state: 'success', detail: '读取 42 行。' },
        ],
      }}
      partnerName="本地伙伴"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    expect(screen.getByText('本地伙伴看完 package.json 了')).toBeInTheDocument();
    expect(screen.queryByText(/K:\\\\workspace/)).not.toBeInTheDocument();
  });

  it('hides internal MCP calls and keeps user-visible MCP effects in plain language', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'mcp-1', sequence: 1, kind: 'tool', toolCallId: 'mcp-1', toolName: 'mcp__ombre_brain__remember', category: 'mcp', summary: '调用 MCP', state: 'success' },
          { id: 'mcp-2', sequence: 2, kind: 'tool', toolCallId: 'mcp-2', toolName: 'mcp__mail__send_message', category: 'mcp', summary: '调用 MCP', state: 'success' },
          { id: 'mcp-3', sequence: 3, kind: 'tool', toolCallId: 'mcp-3', toolName: 'mcp_encoded_web', presentationName: 'mcp__web__web_search', category: 'mcp', summary: '调用 MCP', state: 'success' },
        ],
      }}
      partnerName="本地伙伴"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    const summary = screen.getByText('工具使用完成').closest('summary');
    const details = summary?.closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(summary!);
    expect(details).toHaveAttribute('open');
    expect(screen.queryByText(/ombre_brain|remember/)).not.toBeInTheDocument();
    expect(screen.queryByText(/mail|send_message/)).not.toBeInTheDocument();
    expect(screen.getByText('本地伙伴把消息发出去了')).toBeInTheDocument();
    expect(screen.getByText('本地伙伴冲浪回来了')).toBeInTheDocument();
  });

  it('hides status tools and turns deliver_file into only the independent delivery card', () => {
    const onOpenArtifact = vi.fn();
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'status', sequence: 1, kind: 'tool', toolCallId: 'status-1', toolName: 'asterium_status', category: 'tool', summary: '查询状态', state: 'success' },
          { id: 'deliver', sequence: 2, kind: 'tool', toolCallId: 'deliver-1', toolName: 'deliver_file', category: 'tool', summary: '登记交付', state: 'success' },
          { id: 'file', sequence: 3, kind: 'file', toolCallId: 'deliver-1', artifactId: 'artifact-delivery', name: '最终报告.md', summary: '产出文件', state: 'success' },
        ],
      }}
      partnerName="测试助手"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={onOpenArtifact}
    />);

    expect(screen.queryByText(/asterium_status|deliver_file|查询状态|登记交付/)).not.toBeInTheDocument();
    const delivery = screen.getByRole('button', { name: /最终报告\.md.*文件送到了.*预览/ });
    fireEvent.click(delivery);
    expect(onOpenArtifact).toHaveBeenCalledWith('artifact-delivery');
  });

  it('uses explicit local tool labels and never exposes unknown code names', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'list', sequence: 1, kind: 'tool', toolCallId: 'list-1', toolName: 'list_directory', category: 'file_read', summary: 'list_directory complete', state: 'success' },
          { id: 'search', sequence: 2, kind: 'tool', toolCallId: 'search-1', toolName: 'search_files', category: 'file_read', summary: 'search_files complete', state: 'success' },
          { id: 'unknown', sequence: 3, kind: 'tool', toolCallId: 'unknown-1', toolName: 'vendor_secret_action', category: 'tool', summary: 'vendor_secret_action complete', state: 'success' },
        ],
      }}
      partnerName="测试伙伴"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    expect(screen.getByText('测试伙伴看完目录了')).toBeInTheDocument();
    expect(screen.getByText('测试伙伴找到相关文件了')).toBeInTheDocument();
    expect(screen.getByText('处理好了')).toBeInTheDocument();
    expect(screen.queryByText(/list_directory|search_files|vendor_secret_action/)).not.toBeInTheDocument();
  });

  it('presents deletion, image generation, and collaboration as user-facing actions', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'delete', sequence: 1, kind: 'tool', toolCallId: 'delete-1', toolName: 'delete_path', category: 'tool', summary: 'delete_path complete', state: 'success', detail: '{"path":"K:\\\\workspace\\old.txt"}' },
          { id: 'image', sequence: 2, kind: 'tool', toolCallId: 'image-1', toolName: 'imageGeneration', category: 'tool', summary: 'imageGeneration complete', state: 'success' },
          { id: 'collab', sequence: 3, kind: 'tool', toolCallId: 'collab-1', toolName: 'spawn_agent', category: 'tool', summary: 'spawn_agent complete', state: 'success' },
        ],
      }}
      partnerName="测试助手"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    expect(screen.getByText('测试助手把 old.txt 删掉了')).toBeInTheDocument();
    expect(screen.getByText('测试助手把图片画好了')).toBeInTheDocument();
    expect(screen.getByText('测试助手和小弟一起处理好了')).toBeInTheDocument();
    expect(screen.queryByText(/delete_path|imageGeneration|spawn_agent/)).not.toBeInTheDocument();
  });

  it('hides workspace tool rows already represented by approval and shows unapproved changes', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'workspace-tool-approved', sequence: 1, kind: 'tool', toolCallId: 'workspace-approved', toolName: 'asterium_workspace', category: 'tool', summary: '加入工作区', state: 'success', detail: '{"action":"add","path":"K:\\\\shared"}' },
          { id: 'workspace-auth', sequence: 2, kind: 'authorization', authorizationId: 'auth-workspace', toolCallId: 'workspace-approved', summary: '加入工作区', state: 'success', action: 'external_side_effect', decision: 'allow_once', purpose: 'workspace_add' },
          { id: 'workspace-tool-full', sequence: 3, kind: 'tool', toolCallId: 'workspace-full', toolName: 'asterium_workspace', category: 'tool', summary: '移除工作区', state: 'success', detail: '{"action":"remove","path":"K:\\\\old"}' },
          { id: 'workspace-list', sequence: 4, kind: 'tool', toolCallId: 'workspace-list', toolName: 'asterium_workspace', category: 'tool', summary: '查询工作区', state: 'success', detail: '{"action":"list"}' },
        ],
      }}
      partnerName="测试伙伴"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    expect(screen.getByText('已允许 · 持久加入工作区')).toBeInTheDocument();
    expect(screen.getByText('测试伙伴从工作区移除了')).toBeInTheDocument();
    expect(screen.queryByText(/asterium_workspace|查询工作区/)).not.toBeInTheDocument();
    expect(screen.queryByText('测试伙伴加入了工作区')).not.toBeInTheDocument();
  });

  it('keeps readable approval history while hiding raw commands and technical errors', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'command', sequence: 1, kind: 'tool', toolCallId: 'command-1', toolName: 'Bash', category: 'command', summary: '运行命令 C:\\very-long-command', state: 'success', detail: 'npm run secret -- --verbose' },
          { id: 'authorization', sequence: 2, kind: 'authorization', authorizationId: 'auth-1', summary: '是否允许运行命令', state: 'success', action: 'run_command', decision: 'allow_once' },
          { id: 'error', sequence: 3, kind: 'error', summary: "Claude Code process exited with code 1. stderr: unknown option '--permission-prompts'", detail: 'technical stack trace', state: 'failure' },
        ],
      }}
      partnerName="本地伙伴"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    expect(screen.getByText('本地伙伴从电脑里忙完回来了')).toBeInTheDocument();
    expect(screen.getByText('已允许 · 运行脚本或命令')).toBeInTheDocument();
    expect(screen.getByText('本地伙伴连接中断')).toBeInTheDocument();
    expect(screen.queryByText(/very-long-command|permission-prompts|technical stack trace/)).not.toBeInTheDocument();
  });

  it('shows only the approval card while its operation is waiting', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'write', sequence: 1, kind: 'tool', toolCallId: 'write-1', toolName: 'Edit', category: 'file_write', summary: '写入文件…', state: 'running', detail: '{"file_path":"K:\\\\workspace\\\\report.md"}' },
          { id: 'authorization', sequence: 2, kind: 'authorization', authorizationId: 'auth-1', toolCallId: 'write-1', summary: '是否允许修改 report.md？', detail: 'K:\\workspace\\report.md', state: 'running', action: 'write_file', risk: 'medium' },
        ],
      }}
      partnerName="本地伙伴"
      pendingAuthorization={{ authorizationId: 'auth-1', toolCallId: 'write-1', action: 'write_file', risk: 'medium', summary: '是否允许修改 report.md？', targets: ['K:\\workspace\\report.md'] }}
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    expect(screen.getByText('需要你的确认')).toBeInTheDocument();
    const targetSummary = screen.getByText('查看请求位置').closest('summary');
    expect(targetSummary?.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(targetSummary!);
    expect(targetSummary?.closest('details')).toHaveAttribute('open');
    const locationList = targetSummary?.closest('details')?.querySelector('pre');
    expect(locationList).toHaveTextContent('workspace');
    expect(locationList).toHaveTextContent('report.md');
    expect(screen.queryByText(/正在修改 report\.md/)).not.toBeInTheDocument();
  });

  it('labels a persistent workspace approval separately from allow-once operations', () => {
    const resolve = vi.fn();
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [{ id: 'workspace-auth', sequence: 1, kind: 'authorization', authorizationId: 'workspace-auth', summary: '请求加入持久工作区。', detail: 'K:\\共享目录', state: 'running', action: 'external_side_effect', risk: 'medium', purpose: 'workspace_add' }],
      }}
      partnerName="测试伙伴"
      pendingAuthorization={{ authorizationId: 'workspace-auth', action: 'external_side_effect', risk: 'medium', summary: '请求加入持久工作区。', targets: ['K:\\共享目录'], purpose: 'workspace_add' }}
      onResolveAuthorization={resolve}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    expect(screen.getByText(/持续改变该伙伴的工作区/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '允许一次' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加入工作区' }));
    expect(resolve).toHaveBeenCalledWith('allow_once');
  });

  it('shows delivered files as a compact filename-first row', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'file', sequence: 1, kind: 'file', artifactId: 'artifact-1', name: '交付说明.md', summary: '产出文件：交付说明.md', state: 'success' },
        ],
      }}
      partnerName="本地伙伴"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    const card = screen.getByRole('button', { name: /交付说明\.md.*文件送到了.*预览/ });
    expect(card).toBeInTheDocument();
    expect(card.querySelector('strong')).toHaveTextContent('交付说明.md');
    expect(card.querySelector('small')).toHaveTextContent('文件送到了');
  });

  it('hides generic successful status rows without hiding useful operations', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [
          { id: 'status', sequence: 1, kind: 'status', summary: 'tool completed', state: 'success' },
          { id: 'read', sequence: 2, kind: 'tool', toolCallId: 'read-1', toolName: 'Read', category: 'file_read', summary: '读取完成', state: 'success', detail: '{"path":"K:\\\\workspace\\\\notes.md"}' },
        ],
      }}
      partnerName="本地伙伴"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    expect(screen.queryByText('本地伙伴完成了这一步')).not.toBeInTheDocument();
    expect(screen.getByText('本地伙伴看完 notes.md 了')).toBeInTheDocument();
  });

  it('localizes Recommended while submitting the original option value', () => {
    const onResolveUserInput = vi.fn();
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [{
          id: 'question', sequence: 1, kind: 'user_input', requestId: 'request-1', state: 'running',
          questions: [{ id: 'choice', prompt: '选择下一步', options: [{ label: '开始执行 (Recommended)', description: 'Recommended choice' }, { label: '继续规划' }] }],
        }],
      }}
      partnerName="测试助手"
      pendingUserInput={{ requestId: 'request-1', questions: [{ id: 'choice', prompt: '选择下一步', options: [{ label: '开始执行 (Recommended)', description: 'Recommended choice' }, { label: '继续规划' }] }] }}
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={onResolveUserInput}
      onOpenArtifact={vi.fn()}
    />);

    expect(screen.getByText('开始执行（推荐）')).toBeInTheDocument();
    expect(screen.getByText('推荐 choice')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /开始执行（推荐）/ }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(onResolveUserInput).toHaveBeenCalledWith({ choice: ['开始执行 (Recommended)'] }, undefined, 'request-1');
  });

  it('expands a completed question record to show its exact question and answer', () => {
    render(<TurnTimeline
      message={{
        ...baseMessage,
        timeline: [{
          id: 'question', sequence: 1, kind: 'user_input', requestId: 'request-1', state: 'success',
          questions: [{ id: 'choice', prompt: '选择下一步', options: [{ label: '开始执行 (Recommended)' }, { label: '继续规划' }] }],
          answers: { choice: ['开始执行 (Recommended)'] },
        }],
      }}
      partnerName="测试助手"
      onResolveAuthorization={vi.fn()}
      onResolveUserInput={vi.fn()}
      onOpenArtifact={vi.fn()}
    />);

    const record = screen.getByText('已回答伙伴的澄清问题').closest('details')!;
    expect(record).not.toHaveAttribute('open');
    fireEvent.click(within(record).getByText('已回答伙伴的澄清问题'));
    expect(within(record).getByText('选择下一步')).toBeInTheDocument();
    expect(within(record).getByText('开始执行（推荐）')).toBeInTheDocument();
  });
});
