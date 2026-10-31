import { describe, expect, it } from 'vitest';
import { createTestState } from '../fixtures/applicationState';
import { loadPrototypeState, loadTheme, savePrototypeState, saveTheme, STATE_KEY } from '../../src/renderer/app/persistence';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';

describe('prototype persistence', () => {
  it('does not leave unapplied API guidance waiting forever after an application restart', () => {
    const state = createTestState();
    state.conversations[0].messages.push({ id: 'queued-guidance', authorId: ASTERIUM_USER_ID, content: 'pending', createdAt: '12:00', isGuidance: true, guidanceState: 'queued', status: 'awaiting_confirmation' });
    state.conversations[0].messages.push({ id: 'applied-guidance', authorId: ASTERIUM_USER_ID, content: 'accepted', createdAt: '12:01', isGuidance: true, guidanceState: 'applied', status: 'delivered' });
    savePrototypeState(state);
    const restored = loadPrototypeState();
    expect(restored.conversations[0].messages.find((m) => m.id === 'queued-guidance')?.status).toBe('failed');
    expect(restored.conversations[0].messages.find((m) => m.id === 'applied-guidance')?.status).toBe('delivered');
  });
  it('round-trips versioned state and never invents API credentials', () => {
    const state = createTestState();
    Object.assign(state.partners[2], { apiKey: 'must-never-persist', cookie: 'session=must-never-persist' });
    savePrototypeState(state);
    const raw = localStorage.getItem(STATE_KEY)!;

    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('must-never-persist');
    const restored = loadPrototypeState();
    expect(restored.partners).toEqual(createTestState().partners);
    expect(restored.conversations).toEqual(state.conversations);
  });

  it('removes obsolete PNG ICC profile chunks from persisted avatars without changing other image data', () => {
    const state = createTestState();
    const pngWithProfile = pngDataUrlWithIccProfile();
    state.userProfile.avatarDataUrl = pngWithProfile;
    state.partners[0].publicIdentity.avatarDataUrl = pngWithProfile;
    state.groupChats[0].avatarDataUrl = pngWithProfile;
    localStorage.setItem(STATE_KEY, JSON.stringify(state));

    const restored = loadPrototypeState();
    expect(decodeDataUrl(restored.userProfile.avatarDataUrl!)).not.toContain('iCCP');
    expect(decodeDataUrl(restored.partners[0].publicIdentity.avatarDataUrl!)).not.toContain('iCCP');
    expect(decodeDataUrl(restored.groupChats[0].avatarDataUrl!)).not.toContain('iCCP');
    expect(decodeDataUrl(restored.userProfile.avatarDataUrl!)).toContain('IEND');
  });

  it('marks an interrupted streamed reasoning row as failed after restart', () => {
    const state = createTestState();
    state.conversations[0].messages.push({
      id: 'assistant-running',
      authorId: state.conversations[0].partnerId,
      content: '',
      createdAt: '10:00',
      runId: 'run-running',
      runState: 'running',
      isStreaming: true,
      timeline: [{ id: 'reasoning-row', sequence: 1, kind: 'reasoning', reasoningId: 'reasoning-1', summary: '正在思考', state: 'running', detail: '部分思考' }],
    });
    savePrototypeState(state);
    const restored = loadPrototypeState().conversations[0].messages.at(-1)!;
    expect(restored.runState).toBe('cancelled');
    expect(restored.isStreaming).toBe(false);
    expect(restored.timeline?.[0]).toMatchObject({ kind: 'reasoning', state: 'failure', detail: '部分思考' });
  });

  it('persists unread completion markers until the conversation is opened', () => {
    const state = createTestState();
    state.conversations[0].unreadCompletedAt = '2026-09-30T12:00:00.000Z';
    savePrototypeState(state);
    expect(loadPrototypeState().conversations[0].unreadCompletedAt).toBe('2026-09-30T12:00:00.000Z');
  });

  it('round-trips valid message quote snapshots and drops malformed legacy values', () => {
    const state = createTestState();
    state.conversations[0].messages[0].quote = {
      sourceMessageId: 'assistant-source', sourcePartnerId: 'partner-source', sourcePartnerName: '测试助手', kind: 'selection', text: '引用快照',
    };
    state.conversations[0].messages[1] = { ...state.conversations[0].messages[1], quote: { kind: 'full' } as never };
    savePrototypeState(state);
    const restored = loadPrototypeState().conversations[0].messages;
    expect(restored[0].quote).toEqual(state.conversations[0].messages[0].quote);
    expect(restored[1].quote).toBeUndefined();
  });

  it('persists the selected theme separately', () => {
    saveTheme('dark');
    expect(loadTheme()).toBe('dark');
  });

  it('starts empty for incompatible storage', () => {
    localStorage.setItem(STATE_KEY, JSON.stringify({ version: 99 }));
    expect(loadPrototypeState().version).toBe(7);
    expect(loadPrototypeState().partners).toEqual([]);
  });

  it('splits legacy memory flags into source-enforced management and API session history', () => {
    const legacy = JSON.parse(JSON.stringify(createTestState())) as Record<string, unknown> & { partners: Array<Record<string, unknown>> };
    legacy.version = 6;
    legacy.partners[0].profileManagement = { userProfile: false, personality: false, privateMemory: true };
    legacy.partners[2].profileManagement = { userProfile: true, personality: true, privateMemory: false };
    legacy.partners[2].memoryEnabled = false;
    delete legacy.partners[2].apiSessionHistoryEnabled;
    legacy.partners.push({
      ...legacy.partners[0],
      id: 'legacy-existing',
      sourceMode: 'existing_thread',
      serviceType: 'custom',
      serviceUrl: 'https://example.invalid',
      threadId: 'legacy-thread',
      connectionLabel: '旧线程',
      connectionStatus: 'connected',
      configured: true,
      profileManagement: { userProfile: true, personality: false, privateMemory: true },
    });
    localStorage.clear();
    localStorage.setItem(STATE_KEY, JSON.stringify(legacy));

    const migrated = loadPrototypeState();
    expect(migrated.partners[0].profileManagement?.memoryMode).toBe('asterium');
    expect(migrated.partners[2].profileManagement?.memoryMode).toBe('asterium');
    expect(migrated.partners[2].sourceMode === 'api_partner' && migrated.partners[2].apiSessionHistoryEnabled).toBe(false);
    expect(migrated.partners.at(-1)?.profileManagement?.memoryMode).toBe('none');

    savePrototypeState(migrated);
    const stored = localStorage.getItem(STATE_KEY)!;
    expect(stored).not.toContain('privateMemory');
    expect(stored).not.toContain('memoryEnabled');
  });

  it('discards legacy Project.messages without importing them into the Main-owned group transcript', () => {
    const legacy = JSON.parse(JSON.stringify(createTestState())) as Record<string, unknown> & {
      projects: Array<Record<string, unknown>>;
      groupChats: unknown[];
    };
    const oldMessages = [{ id: 'legacy-project-message', authorId: 'fixture-local-a', content: '不得重新出现', createdAt: '09:00' }];
    legacy.version = 5;
    legacy.projects[0].messages = oldMessages;
    legacy.groupChats = [];
    localStorage.setItem(STATE_KEY, JSON.stringify(legacy));

    const migrated = loadPrototypeState();
    expect('messages' in migrated.projects[0]).toBe(false);
    expect(migrated.groupChats.find((group) => group.projectId === migrated.projects[0].id)?.messages).toEqual([]);

    savePrototypeState(migrated);
    const stored = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as { projects?: Array<Record<string, unknown>> };
    expect(stored.projects?.every((project) => !('messages' in project))).toBe(true);
    expect(localStorage.getItem(STATE_KEY)).not.toContain('不得重新出现');
  });

  it('migrates v1 and old v2 partners without persisting credentials', () => {
    const legacy = createTestState();
    const oldPartner = {
      ...legacy.partners[0],
      sourceMode: 'existing_cli',
      name: '旧伙伴',
      intro: '旧介绍',
      publicIdentity: undefined,
      workspaceGrantId: 'temporary-grant',
      apiKey: 'must-not-survive',
    };
    localStorage.removeItem(STATE_KEY);
    localStorage.setItem(STATE_KEY, JSON.stringify({ ...legacy, version: 1, partners: [oldPartner] }));
    const migrated = loadPrototypeState();
    expect(migrated.partners[0].sourceMode).toBe('local_cli');
    expect(migrated.partners[0].publicIdentity.displayName).toBe('旧伙伴');
    savePrototypeState(migrated);
    const raw = localStorage.getItem(STATE_KEY)!;
    expect(raw).toContain('temporary-grant');
    expect(raw).not.toContain('must-not-survive');
  });

  it('persists workspace grants and runtime choice for restart recovery but strips executable paths', () => {
    const state = createTestState();
    const local = state.partners[0];
    if (local.sourceMode !== 'local_cli') throw new Error('expected local demo partner');
    state.partners[0] = {
      ...local,
      workingDirectories: ['K:\\project-a', 'D:\\shared'],
      workspaceGrantIds: ['grant-a', 'grant-b'],
      primaryWorkspaceGrantId: 'grant-a',
      workspaceGrantId: 'grant-a',
      codexRuntimeId: 'runtime-global',
      codexRuntime: {
        executablePath: 'C:\\Users\\fixture-user\\AppData\\Roaming\\npm\\codex.exe',
        executableLabel: 'codex.exe',
        environment: 'global_cli',
        environmentLabel: '全局 npm CLI',
        codexHome: 'C:\\Users\\fixture-user\\.codex',
        loggedIn: true,
        version: '0.144.5',
        authMethod: 'using ChatGPT',
      },
    };
    savePrototypeState(state);
    const raw = localStorage.getItem(STATE_KEY)!;
    expect(raw).toContain('K:\\\\project-a');
    expect(raw).toContain('D:\\\\shared');
    expect(raw).toContain('grant-a');
    expect(raw).toContain('grant-b');
    expect(raw).toContain('runtime-global');
    expect(raw).not.toContain('AppData');
    expect(raw).toContain('全局 npm CLI');
    const loaded = loadPrototypeState().partners[0];
    expect(loaded.sourceMode === 'local_cli' && loaded.partnerRoot).toBe('K:\\project-a');
    expect(loaded.sourceMode === 'local_cli' && loaded.partnerRootGrantId).toBe('grant-a');
    expect(loaded.sourceMode === 'local_cli' && loaded.workingDirectories).toEqual(['D:\\shared']);
    expect(loaded.sourceMode === 'local_cli' && loaded.workspaceGrantIds).toEqual(['grant-b']);
    expect(loaded.sourceMode === 'local_cli' && loaded.codexRuntimeId).toBe('runtime-global');
    expect(loaded.sourceMode === 'local_cli' && loaded.codexRuntime?.environment).toBe('global_cli');
    expect(loaded.sourceMode === 'local_cli' && loaded.codexRuntime?.executablePath).toBeUndefined();
  });

  it('preserves native assistant history instead of hiding suspected routing errors during hydration', () => {
    const state = createTestState();
    const local = state.partners[0];
    if (local.sourceMode !== 'local_cli') throw new Error('expected local partner');
    state.partners[0] = { ...local, connectionKind: 'local_codex', isPrototype: false };
    state.conversations[0] = {
      ...state.conversations[0],
      messages: [
        { id: 'orphan-1', authorId: local.id, content: '旧 Plan 回复一', createdAt: '12:43' },
        { id: 'orphan-2', authorId: local.id, content: '旧 Plan 回复二', createdAt: '22:27' },
      ],
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));

    expect(loadPrototypeState().conversations[0].messages.map((message) => message.content)).toEqual(['旧 Plan 回复一', '旧 Plan 回复二']);
  });

  it('repairs duplicate persisted message ids without removing either message', () => {
    const state = createTestState();
    const conversation = state.conversations[0];
    state.conversations[0] = {
      ...conversation,
      messages: [
        { id: 'assistant-shared', authorId: conversation.partnerId, content: '插话前回复', createdAt: '12:00', runId: 'run:before-guidance:user-guidance' },
        { id: 'assistant-shared', authorId: conversation.partnerId, content: '插话后回复', createdAt: '12:01', runId: 'run' },
      ],
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));

    const messages = loadPrototypeState().conversations[0].messages;
    expect(messages.map((message) => message.content)).toEqual(['插话前回复', '插话后回复']);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
  });

  it('migrates short-lived disabled cwd conversations back to resumable history', () => {
    const state = createTestState();
    state.conversations[0] = {
      ...state.conversations[0],
      sessionId: 'native-session-preserved',
      partnerRoot: 'K:\\old-cwd',
      partnerRootGrantId: 'grant-old',
      isDisabled: true,
      disabledReason: 'partner_root_changed',
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));

    expect(loadPrototypeState().conversations[0]).toMatchObject({
      sessionId: 'native-session-preserved',
      partnerRoot: 'K:\\old-cwd',
      isDisabled: undefined,
      disabledReason: undefined,
    });
  });

  it('migrates legacy CyberBoss service types and preserves archived conversation state', () => {
    const state = createTestState();
    state.partners[0] = {
      ...state.partners[0],
      sourceMode: 'existing_thread',
      serviceType: 'cyberboss',
      serviceUrl: 'https://bridge.example.test',
      threadId: 'thread-legacy',
      connectionLabel: '旧 CyberBoss',
      connectionStatus: 'connected',
      configured: true,
    } as never;
    state.conversations[0] = {
      ...state.conversations[0],
      isArchived: true,
      archivedAt: '2026-09-12T08:00:00.000Z',
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));

    const loaded = loadPrototypeState();
    expect(loaded.partners[0].sourceMode === 'existing_thread' && loaded.partners[0].serviceType).toBe('cyberboss_server');
    expect(loaded.conversations[0]).toMatchObject({ isArchived: true, archivedAt: '2026-09-12T08:00:00.000Z' });
  });
});

function pngDataUrlWithIccProfile() {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const chunk = (type: string, data: number[]) => [
    0, 0, 0, data.length,
    ...Array.from(type, (character) => character.charCodeAt(0)),
    ...data,
    0, 0, 0, 0,
  ];
  const bytes = Uint8Array.from([...signature, ...chunk('iCCP', [1, 2, 3]), ...chunk('IEND', [])]);
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

function decodeDataUrl(value: string) {
  return Buffer.from(value.slice(value.indexOf(',') + 1), 'base64').toString('latin1');
}
