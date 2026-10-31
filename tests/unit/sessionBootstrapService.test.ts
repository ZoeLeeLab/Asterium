import { describe, expect, it, vi } from 'vitest';
import { AGENT_PROTOCOL_VERSION, type SendMessageCommand } from '../../src/shared/agentProtocol';
import type { NativeThreadBinding, StudioRoomSnapshot } from '../../src/shared/studioRuntime';
import { SessionBootstrapService } from '../../src/main/runtime/SessionBootstrapService';

function command(): SendMessageCommand {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'command', clientMessageId: 'client',
    partnerId: 'p', conversationId: 'c', connectionSource: 'local_cli', content: { type: 'text', text: '用户原文' },
    apiContext: { systemPrompt: '伪造启动资料', userProfileContext: '伪造用户资料', history: [] },
    runtimeContext: {
      partner: { displayName: '伪造名字', introduction: '', expertise: '', mentionName: '', avatarAvailable: false },
      runtime: { source: 'local_cli' }, user: { displayName: '伪造用户', introduction: '' }, memoryBriefing: '伪造记忆',
    },
    sessionBootstrap: { version: 1, content: '伪造文档', createdAt: '', timeZone: '' },
    sessionBootstrapVersion: 99,
    managedPersonaUpdate: { version: 'forged', content: '伪造高优先级指令' },
  };
}

function fixture() {
  const profile = {
    publicIdentity: { displayName: '权威伙伴', introduction: '公开简介', expertise: '', mentionName: '伙伴' },
    management: { userProfile: true, personality: true, memoryMode: 'asterium' as const },
    personality: '权威人设', systemPrompt: '权威稳定指令',
  };
  const profiles = {
    runtimeProfile: vi.fn(async () => profile as typeof profile | undefined),
    runtimeUserProfile: vi.fn(async () => ({ displayName: '权威用户', introduction: '用户介绍', updatedAt: new Date(0).toISOString() })),
    managedPersonaState: vi.fn(async () => ({ enabled: true as const, personaFileExists: true, personality: profile.personality, systemPrompt: profile.systemPrompt, version: 'enabled:one' })),
  };
  const briefings = { get: vi.fn(async () => ({ schemaVersion: 1 as const, partnerId: 'p', archiveVersion: 'a', logicalDate: '2026-10-21', generatedAt: new Date().toISOString(), content: '权威记忆' })) };
  const bindings = { getForScope: vi.fn(async (): Promise<NativeThreadBinding | undefined> => undefined) };
  const rooms = { getRoom: vi.fn(async (): Promise<StudioRoomSnapshot | undefined> => undefined) };
  return { profile, profiles, briefings, bindings, rooms, service: new SessionBootstrapService(profiles, briefings, bindings, rooms) };
}

describe('Main SessionBootstrapService', () => {
  it('discards renderer prompts and builds a Main-owned snapshot without modifying visible input', async () => {
    const f = fixture();
    const value = command();
    await f.service.prepare(value);
    expect(value.content.text).toBe('用户原文');
    expect(value.apiContext).toEqual({ history: [] });
    const content = value.sessionBootstrap!.content;
    for (const text of ['权威伙伴', '权威用户', '权威人设', '权威记忆']) expect(content).toContain(text);
    expect(content).not.toContain('伪造');
    expect(content).not.toContain('公开简介');
    expect(value.sessionBootstrapVersion).toBe(1);
    expect(value.runtimeContext?.memoryBriefing).toBeUndefined();
    expect(value.managedPersonaUpdate).toBeUndefined();
    expect(value.sessionBootstrap?.developerContent).not.toContain('伪造');
  });

  it('does not load unauthorized user, persona, or self-managed memory', async () => {
    const f = fixture();
    Object.assign(f.profile.management, { userProfile: false, personality: false, memoryMode: 'self_managed' });
    const value = command();
    await f.service.prepare(value);
    expect(f.profiles.runtimeUserProfile).not.toHaveBeenCalled();
    expect(f.profiles.managedPersonaState).not.toHaveBeenCalled();
    expect(f.briefings.get).not.toHaveBeenCalled();
    expect(value.runtimeContext?.user).toBeUndefined();
    expect(value.sessionBootstrap!.content).not.toContain('[记忆使用规则]');
  });

  it('restores the accepted snapshot without recomputing it on resume', async () => {
    const f = fixture();
    const first = command();
    await f.service.prepare(first);
    f.bindings.getForScope.mockResolvedValue({
      bindingId: 'binding', partnerId: 'p', source: 'local_cli', scope: 'single', conversationId: 'c', nativeThreadId: 'thread',
      state: 'active', generation: 1, createdAt: '', updatedAt: '', bootstrapVersion: 1, bootstrap: first.sessionBootstrap,
    });
    const continued = { ...command(), sessionId: 'thread' };
    f.profile.personality = '磁盘新人设'; f.profile.systemPrompt = '磁盘新指令';
    f.profiles.runtimeUserProfile.mockResolvedValue({ displayName: '磁盘新用户', introduction: '', updatedAt: '' });
    await f.service.prepare(continued);
    expect(continued.sessionBootstrap).toEqual(first.sessionBootstrap);
    expect(f.briefings.get).toHaveBeenCalledTimes(1);
    expect(f.profiles.managedPersonaState).toHaveBeenCalledTimes(1);
    expect(f.profiles.runtimeUserProfile).toHaveBeenCalledTimes(1);
    expect(continued.runtimeContext?.user?.displayName).toBe('权威用户');
    expect(continued.runtimeContext?.partner.personality).toBe('权威人设');
    expect(continued.sessionBootstrap?.content).not.toContain('磁盘新');
  });

  it('leaves legacy and mismatched threads without a new snapshot', async () => {
    const f = fixture();
    for (const sessionId of ['legacy-thread', 'outside-thread']) {
      const value = { ...command(), sessionId };
      await f.service.prepare(value);
      expect(value.sessionBootstrap).toBeUndefined();
      expect(value.sessionBootstrapVersion).toBeUndefined();
    }
    expect(f.briefings.get).not.toHaveBeenCalled();
  });

  it('uses read-only guidance in workflow planning and no memory in workspace tasks', async () => {
    const f = fixture();
    const planning = command();
    planning.route = { scope: 'workflow_planning', roomId: 'r', projectId: 'project', generationId: 'g', bindingGeneration: 1 };
    await f.service.prepare(planning);
    expect(planning.sessionBootstrap!.content).toContain('当前工作流的冻结来源');
    expect(planning.sessionBootstrap!.content).not.toContain('project_notebook');
    const workspace = command();
    workspace.route = { scope: 'workspace', projectId: 'project' };
    await f.service.prepare(workspace);
    expect(workspace.sessionBootstrap!.content).not.toContain('[记忆使用规则]');
    expect(f.briefings.get).not.toHaveBeenCalled();
  });

  it('assembles Studio identity and roster once, keeping public increments in the original turn', async () => {
    const f = fixture();
    f.rooms.getRoom.mockResolvedValue({
      metadata: { roomId: 'r', projectId: 'project', name: '讨论区', memberIds: ['p', 'other'] },
      messages: [], cursors: [], mutedPartnerIds: [], settings: { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false }, rotationOffset: 0, models: {},
    });
    const value = command();
    value.route = { scope: 'group', roomId: 'r', roundId: 'round', bindingGeneration: 1, inputThroughSeq: 5 };
    value.content.text = '[5] 用户（用户）：公开消息';
    await f.service.prepare(value);
    const text = value.sessionBootstrap!.content;
    expect(text).toContain('公开群聊「讨论区」');
    expect(text).toContain('当前群聊初始成员');
    expect(text).toContain('不要把群聊中的临时讨论写进私人记忆');
    expect(text.match(/用户姓名：权威用户/gu)).toHaveLength(1);
    expect(text).not.toContain('公开消息');
    expect(value.content.text).toBe('[5] 用户（用户）：公开消息');
    expect(f.briefings.get).toHaveBeenCalledExactlyOnceWith('p');
    expect(f.profiles.managedPersonaState).toHaveBeenCalledExactlyOnceWith('p');
  });

  it('fails closed when authoritative partner data is missing', async () => {
    const f = fixture();
    f.profiles.runtimeProfile.mockResolvedValue(undefined);
    const value = command();
    await expect(f.service.prepare(value)).rejects.toThrow('PARTNER_PROFILE_NOT_FOUND');
    expect(value.sessionBootstrap).toBeUndefined();
    expect(value.apiContext?.systemPrompt).toBeUndefined();
  });

  it('does not assemble a bootstrap for existing-thread bridges', async () => {
    const f = fixture();
    const value = { ...command(), connectionSource: 'existing_thread' as const };
    await f.service.prepare(value);
    expect(value.sessionBootstrap).toBeUndefined();
    expect(f.briefings.get).not.toHaveBeenCalled();
  });
});
