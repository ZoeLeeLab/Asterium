import { describe, expect, it } from 'vitest';
import { apiSessionBootstrapSystemPrompt, shouldBootstrapMemoryBriefing } from '../../src/main/memory/MemoryBriefingBootstrap';
import { AGENT_PROTOCOL_VERSION, type SendMessageCommand } from '../../src/shared/agentProtocol';

function command(overrides: Partial<SendMessageCommand> = {}): SendMessageCommand {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'message.send',
    commandId: 'command-1',
    partnerId: 'partner-1',
    conversationId: 'conversation-1',
    connectionSource: 'local_cli',
    clientMessageId: 'client-1',
    content: { type: 'text', text: '你好' },
    runtimeContext: {
      partner: { displayName: '测试助手', introduction: '', expertise: '', mentionName: '测试助手', avatarAvailable: false },
      runtime: { source: 'local_cli', adapter: 'codex_cli' },
    },
    ...overrides,
  };
}

describe('memory briefing bootstrap eligibility', () => {
  it('allows new ordinary single-chat and Studio sessions for managed API and local partners', () => {
    expect(shouldBootstrapMemoryBriefing(command(), 'asterium')).toBe(true);
    expect(shouldBootstrapMemoryBriefing(command({ route: { scope: 'single' } }), 'asterium')).toBe(true);
    expect(shouldBootstrapMemoryBriefing(command({
      connectionSource: 'api_partner',
      route: { scope: 'group', roomId: 'room-1', roundId: 'round-1', bindingGeneration: 1, inputThroughSeq: 0 },
    }), 'asterium')).toBe(true);
  });

  it('rejects continuations, self-managed partners, workflows, workspace tasks, and existing-thread bridges', () => {
    expect(shouldBootstrapMemoryBriefing(command({ sessionId: 'session-1' }), 'asterium')).toBe(false);
    expect(shouldBootstrapMemoryBriefing(command(), 'self_managed')).toBe(false);
    expect(shouldBootstrapMemoryBriefing(command({ route: { scope: 'workflow_planning', projectId: 'project-1', roomId: 'room-1', generationId: 'generation-1', bindingGeneration: 1 } }), 'asterium')).toBe(false);
    expect(shouldBootstrapMemoryBriefing(command({ route: { scope: 'workspace', projectId: 'project-1' } }), 'asterium')).toBe(false);
    expect(shouldBootstrapMemoryBriefing(command({ connectionSource: 'existing_thread' }), 'asterium')).toBe(false);
  });
});

describe('API session bootstrap prompt', () => {
  it('adds memory to a Studio API bootstrap without duplicating single-chat identity or user profile', () => {
    const runtimeContext = command().runtimeContext!;
    runtimeContext.memoryBriefing = '自我认知：持续协作';
    const prompt = apiSessionBootstrapSystemPrompt({
      partnerName: '测试伙伴', group: true, managedUserProfile: true, userProfileContext: '用户私有资料', runtimeContext,
    });
    expect(prompt).toContain('自我认知：持续协作');
    expect(prompt).not.toContain('你在星丛中的名字');
    expect(prompt).not.toContain('用户私有资料');
  });

  it('keeps the existing single-chat identity bootstrap and appends managed memory', () => {
    const runtimeContext = command().runtimeContext!;
    runtimeContext.memoryBriefing = '关系：长期伙伴';
    const prompt = apiSessionBootstrapSystemPrompt({
      partnerName: '测试伙伴', group: false, managedUserProfile: true, userProfileContext: '用户', runtimeContext,
    });
    expect(prompt).toContain('你在星丛中的名字：测试伙伴');
    expect(prompt).toContain('关于当前用户：\n用户');
    expect(prompt).toContain('关系：长期伙伴');
  });
});
