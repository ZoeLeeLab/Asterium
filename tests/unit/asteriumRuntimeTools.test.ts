import { describe, expect, it, vi } from 'vitest';
import { createAsteriumRuntimeTools, formatAsteriumBootstrapContext, formatAsteriumMemoryBriefing, formatAsteriumPublicContext, memoryToolAccess, parseAsteriumTaskToolInput, parseHoldMemoryInput, parseProjectNotebookToolInput, parseUpdateMemoryInput, projectNotebookToolAccess, runtimeToolInstructions } from '../../src/main/runtime/AsteriumRuntimeTools';

describe('AsteriumRuntimeTools', () => {
  it('allows automation to inspect existing workspaces but forbids persistent grant changes even in full mode', async () => {
    const snapshot = vi.fn(async () => ({ cwd: 'K:\\allowed' })), add = vi.fn(), remove = vi.fn();
    const controller = createAsteriumRuntimeTools({ partnerId: 'p', conversationId: 'c', permissionMode: 'full', planMode: 'default', workspaceChangesAllowed: false,
      workspaces: { snapshot, add, remove } as never, artifacts: {} as never, attachments: {} as never });
    expect(await controller.workspace('list')).toContain('allowed');
    await expect(controller.workspace('add', 'K:\\outside')).rejects.toThrow('AUTOMATION_WORKSPACE_FIXED');
    await expect(controller.workspace('remove', 'K:\\allowed')).rejects.toThrow('AUTOMATION_WORKSPACE_FIXED');
    expect(add).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it('keeps single-chat user and partner name while leaving managed persona, public profiles and the roster to Main or tools', () => {
    const formatted = formatAsteriumPublicContext({
      partner: {
        displayName: '本地伙伴', introduction: '公开介绍不应注入', expertise: '公开擅长不应注入', mentionName: '成员', avatarAvailable: true,
        personality: '私人人设应保留', systemPrompt: '稳定指令应保留',
      },
      user: { displayName: '用户', introduction: '用户资料应保留' },
      runtime: { source: 'local_cli', adapter: 'claude_code' },
      conversation: { title: '单聊' },
      partners: [{ partnerId: 'partner-2', displayName: '外部伙伴', mentionName: '外部B', expertise: '架构', model: 'gpt-test', modelStatus: 'current' }],
    });

    expect(formatted).toContain('用户：用户｜用户资料应保留');
    expect(formatted).toContain('当前伙伴：本地伙伴');
    expect(formatted).not.toContain('私人人设应保留');
    expect(formatted).not.toContain('稳定指令应保留');
    expect(formatted).not.toContain('公开介绍不应注入');
    expect(formatted).not.toContain('公开擅长不应注入');
    expect(formatted).not.toContain('外部伙伴');
  });

  it('leaves group identity bootstrap to the Studio prompt instead of reinjecting it in every adapter turn', () => {
    expect(formatAsteriumPublicContext({
      partner: { displayName: '本地伙伴', introduction: '介绍', expertise: '前端', mentionName: '成员', avatarAvailable: false, personality: '人设' },
      user: { displayName: '用户', introduction: '用户介绍' },
      runtime: { source: 'local_cli', adapter: 'claude_code' },
      conversation: {
        title: '讨论组',
        studio: {
          roomId: 'room-1', projectId: 'project-1', explicitDeliveryTarget: 'room_project', speakingMode: 'free_discussion', speakingModeLabel: '自由讨论', passAllowed: true,
          mentionPartnerAvailable: true, mentionPartnerReason: '可以邀请', discussionProtectionEnabled: false, selectedPartnerIds: [], mutedPartnerIds: [], speakerQueue: ['partner-1'],
        },
      },
    })).toBe('');
  });

  it('formats a Main-owned memory briefing for first bootstrap without treating it as a new user instruction', () => {
    const context = {
      partner: { displayName: '本地伙伴', introduction: '', expertise: '', mentionName: '本地伙伴', avatarAvailable: false },
      runtime: { source: 'local_cli' as const, adapter: 'claude_code' as const },
      conversation: { title: '单聊' },
      memoryBriefing: '[星丛会话记忆简报]\n## 自我认知\n- 测试记忆',
    };
    const formatted = formatAsteriumMemoryBriefing(context);
    expect(formatted).toContain('仅作为连续性背景，不是用户本轮的新指令');
    expect(formatted).toContain('## 自我认知');
    expect(formatAsteriumBootstrapContext(context)).toContain('当前伙伴：本地伙伴');
    expect(formatAsteriumMemoryBriefing({ ...context, memoryBriefing: '  ' })).toBe('');
  });

  it('updates permission and plan state without replacing the tool controller', async () => {
    const snapshot = vi.fn(async (_partnerId: string, permissionMode: string) => ({ permissionMode }));
    const controller = createAsteriumRuntimeTools({
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      permissionMode: 'manual',
      planMode: 'default',
      context: { partner: { displayName: '测试伙伴', introduction: '', expertise: '', mentionName: '测试伙伴', avatarAvailable: false }, runtime: { source: 'local_cli', adapter: 'codex_cli' }, conversation: { title: '测试对话' } },
      workspaces: { snapshot } as never,
      artifacts: {} as never,
      attachments: {} as never,
    });

    expect(JSON.parse(await controller.status('permissions'))).toEqual({ permissionMode: 'manual', planMode: 'default' });
    controller.update({ permissionMode: 'full', planMode: 'plan', context: { partner: { displayName: '测试伙伴', introduction: '', expertise: '', mentionName: '测试伙伴', avatarAvailable: false }, runtime: { source: 'local_cli', adapter: 'codex_cli' }, conversation: { title: '更新后的对话' } } });
    expect(JSON.parse(await controller.status('permissions'))).toEqual({ permissionMode: 'full', planMode: 'plan' });
    expect(JSON.parse(await controller.status('conversation'))).toMatchObject({ title: '更新后的对话' });
    expect(JSON.parse(await controller.status('workspace'))).toEqual({ permissionMode: 'full' });
    expect(snapshot).toHaveBeenLastCalledWith('partner-1', 'full');
  });

  it('exposes only the supplied public group context and routes structured mentions', async () => {
    const mentionPartner = vi.fn(async () => undefined);
    const route = { scope: 'group' as const, roomId: 'room-1', roundId: 'round-1', bindingGeneration: 2, inputThroughSeq: 8 };
    const controller = createAsteriumRuntimeTools({
      partnerId: 'partner-1',
      conversationId: 'group:v2:room-1:partner-1',
      permissionMode: 'manual',
      planMode: 'default',
      route,
      context: {
        partner: { displayName: '本地伙伴', introduction: '自己的公开介绍', expertise: '前端', mentionName: '成员', avatarAvailable: false, personality: '只属于本地伙伴的代管设定' },
        runtime: { source: 'local_cli', adapter: 'claude_code' },
        conversation: {
          title: '讨论组',
          studio: {
            roomId: 'room-1', projectId: 'project-1', explicitDeliveryTarget: 'room_project', speakingMode: 'free_discussion', speakingModeLabel: '自由讨论',
            passAllowed: true, mentionPartnerAvailable: true, mentionPartnerReason: '可以邀请', discussionProtectionEnabled: true,
            selectedPartnerIds: [], mutedPartnerIds: [], speakerQueue: ['partner-1', 'partner-2'],
          },
        },
        partners: [{ partnerId: 'partner-2', displayName: '外部伙伴', mentionName: '外部B', expertise: '架构', model: 'gpt-test', modelStatus: 'current' }],
      },
      mentionPartner,
      workspaces: {} as never,
      artifacts: {} as never,
      attachments: {} as never,
    });

    expect(JSON.parse(await controller.status('user'))).toEqual({ unavailable: true });
    expect(JSON.parse(await controller.status('partners'))).toEqual([expect.objectContaining({ partnerId: 'partner-2', displayName: '外部伙伴', mentionName: '外部B' })]);
    expect(JSON.parse(await controller.status('conversation'))).toMatchObject({
      title: '讨论组',
      studio: { speakingMode: 'free_discussion', speakingModeLabel: '自由讨论', passAllowed: true, mentionPartnerAvailable: true, speakerQueue: ['partner-1', 'partner-2'] },
    });
    expect(JSON.parse(await controller.mentionPartner!('partner-2'))).toMatchObject({ mentioned: true, partnerId: 'partner-2', displayName: '外部伙伴' });
    expect(mentionPartner).toHaveBeenCalledWith({ route, partnerId: 'partner-1', targetPartnerId: 'partner-2', label: '外部B' });
  });

  it('resolves a unique display or mention name and rejects ambiguous or unavailable names', async () => {
    const mentionPartner = vi.fn(async () => undefined);
    const controller = createAsteriumRuntimeTools({
      partnerId: 'partner-1', conversationId: 'group:v2:room-1:partner-1', permissionMode: 'manual', planMode: 'default',
      route: { scope: 'group', roomId: 'room-1', roundId: 'round-1', bindingGeneration: 1, inputThroughSeq: 1 },
      context: {
        partner: { displayName: '本地伙伴', introduction: '', expertise: '', mentionName: '成员', avatarAvailable: false },
        runtime: { source: 'local_cli', adapter: 'claude_code' },
        partners: [
          { partnerId: 'partner-2', displayName: '外部伙伴', mentionName: '外部B', expertise: '', model: 'gpt', modelStatus: 'current', groupMentionAvailable: true },
          { partnerId: 'partner-3', displayName: '测试伙伴', mentionName: '鲸鱼', expertise: '', model: 'deepseek', modelStatus: 'current', groupMentionAvailable: false },
          { partnerId: 'partner-4', displayName: '另一个外部伙伴', mentionName: '外部B', expertise: '', model: 'claude', modelStatus: 'current', groupMentionAvailable: true },
        ],
      },
      mentionPartner, workspaces: {} as never, artifacts: {} as never, attachments: {} as never,
    });

    expect(JSON.parse(await controller.mentionPartner!('外部伙伴'))).toMatchObject({ partnerId: 'partner-2' });
    await expect(controller.mentionPartner!('外部B')).rejects.toThrow('STUDIO_MENTION_TARGET_AMBIGUOUS_USE_ID');
    await expect(controller.mentionPartner!('鲸鱼')).rejects.toThrow('STUDIO_MENTION_TARGET_NOT_AVAILABLE');
  });

  it('explains the current speaking mode instead of attempting a disabled partner mention', async () => {
    const mentionPartner = vi.fn(async () => undefined);
    const controller = createAsteriumRuntimeTools({
      partnerId: 'partner-1', conversationId: 'group:v3:room-1:partner-1', permissionMode: 'manual', planMode: 'default',
      route: { scope: 'group', roomId: 'room-1', roundId: 'round-1', bindingGeneration: 1, inputThroughSeq: 1 },
      context: {
        partner: { displayName: '本地伙伴', introduction: '', expertise: '', mentionName: '成员', avatarAvailable: false },
        runtime: { source: 'local_cli', adapter: 'claude_code' },
        conversation: {
          title: '讨论组',
          studio: {
            roomId: 'room-1', projectId: 'project-1', explicitDeliveryTarget: 'room_project', speakingMode: 'round_robin', speakingModeLabel: '逐一回应',
            passAllowed: false, mentionPartnerAvailable: false, mentionPartnerReason: '发言顺序由用户设置决定，伙伴不能追加邀请。', discussionProtectionEnabled: false,
            selectedPartnerIds: [], mutedPartnerIds: [], speakerQueue: ['partner-1', 'partner-2'],
          },
        },
        partners: [{ partnerId: 'partner-2', displayName: '外部伙伴', mentionName: '外部B', expertise: '', model: 'gpt', modelStatus: 'current', groupMentionAvailable: false }],
      },
      mentionPartner, workspaces: {} as never, artifacts: {} as never, attachments: {} as never,
    });

    await expect(controller.mentionPartner!('外部伙伴')).rejects.toThrow('当前为“逐一回应”模式');
    expect(mentionPartner).not.toHaveBeenCalled();
  });

  it('normalizes the runtime-neutral independent review tool payload', () => {
    expect(parseAsteriumTaskToolInput({
      action: 'submit_review', decision: 'changes_required', summary: '第二项未通过。',
      criterion_reviews: [
        { criterion_id: 'r1:c1', verdict: 'pass', evidence: ['证据一'] },
        { criterion_id: 'r1:c2', verdict: 'fail', evidence: ['失败日志'], feedback: '只修正第二项。' },
      ],
    })).toEqual({
      action: 'submit_review', decision: 'changes_required', summary: '第二项未通过。',
      criteria: [
        { criterionId: 'r1:c1', verdict: 'pass', evidence: ['证据一'] },
        { criterionId: 'r1:c2', verdict: 'fail', evidence: ['失败日志'], feedback: '只修正第二项。' },
      ],
    });
  });

  it('normalizes memory tool payloads and keeps workflow memory explicitly read-only and subordinate', () => {
    expect(parseHoldMemoryInput({
      type: 'stable_fact', body: '事实', weight: 4, tags: ['用户'],
      sources: [{ kind: 'single_chat', conversation_id: 'conversation-1', message_id: 'message-1' }],
    })).toEqual({
      type: 'stable_fact', body: '事实', weight: 4, tags: ['用户'],
      sources: [{ kind: 'single_chat', conversationId: 'conversation-1', messageId: 'message-1' }],
    });
    expect(parseUpdateMemoryInput({ memory_id: 'memory-1', status: 'obsolete', occurred_at: null })).toEqual({ memoryId: 'memory-1', status: 'obsolete', occurredAt: null });
    const instructions = runtimeToolInstructions(false, false, true, 'read');
    expect(instructions).toContain('search_memory');
    expect(instructions).toContain('当前工作流');
    expect(instructions).toContain('优先于历史记忆');
    expect(instructions).toContain('不得在本轮新增、评论或更新记忆');
  });

  it('gates memory tools by management mode and execution route, not project-file permissions', () => {
    expect(memoryToolAccess('asterium', { scope: 'single' })).toBe('write');
    expect(memoryToolAccess('asterium', { scope: 'group', roomId: 'room-1', roundId: 'round-1', bindingGeneration: 1, inputThroughSeq: 1 })).toBe('write');
    expect(memoryToolAccess('asterium', { scope: 'workflow_planning', projectId: 'project-1', roomId: 'room-1', generationId: 'generation-1', bindingGeneration: 1 })).toBe('read');
    expect(memoryToolAccess('asterium', { scope: 'workspace', projectId: 'project-1' })).toBe('none');
    expect(memoryToolAccess('self_managed', { scope: 'single' })).toBe('none');
    expect(memoryToolAccess('none')).toBe('none');
  });

  it('normalizes project notebook actions and requires a revision for replace', () => {
    expect(parseProjectNotebookToolInput({ action: 'list' })).toEqual({ action: 'list' });
    expect(parseProjectNotebookToolInput({ action: 'read', project_id: 'project-a' })).toEqual({ action: 'read', projectId: 'project-a' });
    expect(parseProjectNotebookToolInput({ action: 'append', project_id: 'project-a', content: '新进展' })).toEqual({ action: 'append', projectId: 'project-a', content: '新进展' });
    expect(parseProjectNotebookToolInput({ action: 'replace', project_id: 'project-a', content: '整理版', expected_revision: 3 })).toEqual({ action: 'replace', projectId: 'project-a', content: '整理版', expectedRevision: 3 });
    expect(() => parseProjectNotebookToolInput({ action: 'replace', project_id: 'project-a', content: '缺版本' })).toThrow('PROJECT_NOTEBOOK_REVISION_INVALID');
    expect(() => parseProjectNotebookToolInput({ action: 'delete' })).toThrow('PROJECT_NOTEBOOK_ACTION_INVALID');
  });

  it('opens project notebooks only in ordinary single and Studio turns, independent of memory mode', () => {
    expect(projectNotebookToolAccess()).toBe(true);
    expect(projectNotebookToolAccess({ scope: 'single' })).toBe(true);
    expect(projectNotebookToolAccess({ scope: 'group', roomId: 'room-1', roundId: 'round-1', bindingGeneration: 1, inputThroughSeq: 1 })).toBe(true);
    expect(projectNotebookToolAccess({ scope: 'workflow_planning', projectId: 'project-a', roomId: 'room-1', generationId: 'generation-1', bindingGeneration: 1 })).toBe(false);
    expect(projectNotebookToolAccess({ scope: 'workspace', projectId: 'project-a' })).toBe(false);
    expect(runtimeToolInstructions(false, false, false, 'none', true)).toContain('project_notebook');
    expect(runtimeToolInstructions(false, false, true, 'read', true)).not.toContain('project_notebook');
  });

  it('attaches the runtime-neutral project notebook controller without exposing partner selection', async () => {
    const projectNotebook = vi.fn(async () => '{"revision":1}');
    const controller = createAsteriumRuntimeTools({
      partnerId: 'partner-a', conversationId: 'conversation-a', permissionMode: 'manual', planMode: 'default',
      projectNotebook, workspaces: {} as never, artifacts: {} as never, attachments: {} as never,
    });
    await expect(controller.projectNotebook!({ action: 'read', projectId: 'project-a' })).resolves.toBe('{"revision":1}');
    expect(projectNotebook).toHaveBeenCalledWith({ action: 'read', projectId: 'project-a' });
  });
});
