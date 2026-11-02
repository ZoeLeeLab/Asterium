import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('NativeThreadBindingStore', () => {
  it('invalidates only the failing group generation, preserving a rejoin and other scopes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-binding-failure-')); temporary.push(directory);
    const file = path.join(directory, 'bindings.json'), bindings = new NativeThreadBindingStore(file);
    const input = { partnerId: 'p', source: 'api_partner' as const, scope: 'group' as const, roomId: 'r', conversationId: 'group:v3:r:p', generationScopedConversation: true };
    const first = await bindings.reserve(input); await bindings.activate(first.bindingId, 'old-thread');
    const single = await bindings.registerSingle({ partnerId: 'p', source: 'api_partner', conversationId: 'single', nativeThreadId: 'single-thread' });
    const other = await bindings.reserve({ ...input, roomId: 'other' });
    const command = { partnerId: 'p', connectionSource: 'api_partner' as const, conversationId: first.conversationId,
      route: { scope: 'group' as const, roomId: 'r', roundId: 'old-round', bindingGeneration: first.generation, inputThroughSeq: 1 } };
    await bindings.invalidateGroupTurn(command);
    expect(await bindings.getForScope('p', 'group', 'r')).toBeUndefined();
    const fresh = await bindings.reserve(input); await bindings.activate(fresh.bindingId, 'fresh-thread');
    await bindings.invalidateGroupTurn(command);
    await bindings.invalidateGroupTurn({ ...command, conversationId: fresh.conversationId });
    await bindings.invalidateGroupTurn({ ...command, route: { ...command.route, bindingGeneration: fresh.generation } });
    await bindings.invalidateGroupTurn({ ...command, connectionSource: 'local_cli', conversationId: fresh.conversationId, route: { ...command.route, bindingGeneration: fresh.generation } });
    const restarted = new NativeThreadBindingStore(file);
    expect(await restarted.getForScope('p', 'group', 'r')).toMatchObject({ bindingId: fresh.bindingId, state: 'active' });
    await restarted.invalidateGroupTurn({ ...command, conversationId: fresh.conversationId, route: { ...command.route, bindingGeneration: fresh.generation } });
    expect(await restarted.getForScope('p', 'group', 'r')).toBeUndefined();
    expect((await restarted.getForScope('p', 'single', 'single'))?.bindingId).toBe(single.bindingId);
    expect((await restarted.getForScope('p', 'group', 'other'))?.bindingId).toBe(other.bindingId);
  });
  it('scopes API caches by durable generation while retaining existing valid legacy binding keys', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-binding-generation-')); temporary.push(directory);
    const file = path.join(directory, 'bindings.json'), bindings = new NativeThreadBindingStore(file);
    const input = { partnerId: 'p', source: 'api_partner' as const, scope: 'group' as const, roomId: 'r', conversationId: 'group:v3:r:p' };
    const legacy = await bindings.reserve(input); await bindings.activate(legacy.bindingId, 'api-one');
    expect((await bindings.reserve({ ...input, generationScopedConversation: true })).conversationId).toBe(legacy.conversationId);
    await bindings.invalidateRoomMembers('r', ['p']);
    const restarted = new NativeThreadBindingStore(file);
    const next = await restarted.reserve({ ...input, generationScopedConversation: true });
    expect(next.conversationId).toBe('group:v3:r:p:generation:2'); expect(next.nativeThreadId).toBeUndefined();
    const { ApiAgentSessionStore } = await import('../../src/main/api/ApiAgentSessionStore');
    const sessions = new ApiAgentSessionStore(path.join(directory, 'sessions'));
    await sessions.remember({ version: 1, partnerId: 'p', conversationId: legacy.conversationId, provider: 'fixture', bootstrapSystemPrompt: '旧人设和私有工具记录', turns: [], updatedAt: '' });
    expect(await sessions.load('p', next.conversationId)).toBeUndefined();
    expect((await sessions.load('p', legacy.conversationId))?.bootstrapSystemPrompt).toContain('旧人设');
  });
  it('increments generation after invalidation instead of reusing the old context assumption', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-binding-'));
    temporary.push(directory);
    const bindings = new NativeThreadBindingStore(path.join(directory, 'bindings.json'));
    const first = await bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'group', conversationId: 'group:room-a:partner-a', roomId: 'room-a' });
    await bindings.activate(first.bindingId, 'thread-a');
    await bindings.invalidate(first.bindingId);
    const second = await bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'group', conversationId: 'group:room-a:partner-a', roomId: 'room-a' });
    expect(second).toMatchObject({ generation: 2, state: 'pending' });
    expect(await bindings.isBoundNativeThread('thread-a')).toBe(true);
  });

  it('keeps group threads out of reusable single-thread discovery', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-binding-'));
    temporary.push(directory);
    const bindings = new NativeThreadBindingStore(path.join(directory, 'bindings.json'));
    const group = await bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'group', conversationId: 'group:room-a:partner-a', roomId: 'room-a' });
    await bindings.activate(group.bindingId, 'thread-group');
    expect(await bindings.activeNativeThreadIds('group')).toEqual(['thread-group']);
    await expect(bindings.registerSingle({ partnerId: 'partner-a', source: 'local_cli', conversationId: 'single-a', nativeThreadId: 'thread-group' })).rejects.toThrow('NATIVE_THREAD_ALREADY_BOUND');
  });

  it('keeps one partner single and group bindings independent through invalidation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-binding-'));
    temporary.push(directory);
    const bindings = new NativeThreadBindingStore(path.join(directory, 'bindings.json'));
    const single = await bindings.registerSingle({ partnerId: 'partner-a', source: 'local_cli', conversationId: 'single-a', nativeThreadId: 'thread-single' });
    const groupPending = await bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'group', conversationId: 'group:v3:room-a:partner-a', roomId: 'room-a' });
    const group = await bindings.activate(groupPending.bindingId, 'thread-group');

    expect(await bindings.getForScope('partner-a', 'single', 'single-a')).toMatchObject({ bindingId: single.bindingId, nativeThreadId: 'thread-single' });
    expect(await bindings.getForScope('partner-a', 'group', 'room-a')).toMatchObject({ bindingId: group.bindingId, nativeThreadId: 'thread-group' });

    await bindings.invalidate(group.bindingId);
    expect(await bindings.getForScope('partner-a', 'group', 'room-a')).toBeUndefined();
    expect(await bindings.getForScope('partner-a', 'single', 'single-a')).toMatchObject({ bindingId: single.bindingId, state: 'active' });
    expect(await bindings.activeNativeThreadIds('single')).toEqual(['thread-single']);
  });

  it('replaces a single-chat binding when its native thread changes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-binding-'));
    temporary.push(directory);
    const filePath = path.join(directory, 'bindings.json');
    const bindings = new NativeThreadBindingStore(filePath);
    const first = await bindings.registerSingle({ partnerId: 'partner-a', source: 'local_cli', conversationId: 'single-a', nativeThreadId: 'thread-old' });

    const second = await bindings.registerSingle({ partnerId: 'partner-a', source: 'local_cli', conversationId: 'single-a', nativeThreadId: 'thread-new' });
    const repeated = await bindings.registerSingle({ partnerId: 'partner-a', source: 'local_cli', conversationId: 'single-a', nativeThreadId: 'thread-new' });
    const stored = JSON.parse(await readFile(filePath, 'utf8')) as { bindings: Array<{ bindingId: string; state: string }> };

    expect(first).toMatchObject({ generation: 1, state: 'active', nativeThreadId: 'thread-old' });
    expect(second).toMatchObject({ generation: 2, state: 'active', nativeThreadId: 'thread-new' });
    expect(repeated.bindingId).toBe(second.bindingId);
    expect(stored.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ bindingId: first.bindingId, state: 'invalid' }),
      expect.objectContaining({ bindingId: second.bindingId, state: 'active' }),
    ]));
    expect(await bindings.activeNativeThreadIds('single')).toEqual(['thread-new']);
  });

  it('records the last native turn completed through Asterium', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-binding-'));
    temporary.push(directory);
    const bindings = new NativeThreadBindingStore(path.join(directory, 'bindings.json'));
    const pending = await bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'group', conversationId: 'group:room-a:partner-a', roomId: 'room-a' });
    const active = await bindings.activate(pending.bindingId, 'thread-group');
    await bindings.markCompleted(active.bindingId, 'turn-owned');
    expect(await bindings.getForScope('partner-a', 'group', 'room-a')).toMatchObject({ lastCompletedRunId: 'turn-owned' });
  });

  it('persists the managed persona version on the active native thread binding', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-binding-'));
    temporary.push(directory);
    const filePath = path.join(directory, 'bindings.json');
    const bindings = new NativeThreadBindingStore(filePath);
    const active = await bindings.registerSingle({
      partnerId: 'partner-a',
      source: 'local_cli',
      conversationId: 'single-a',
      nativeThreadId: 'thread-single',
    });

    await bindings.markPersonaVersion(active.bindingId, 'enabled:persona-v1');

    const restored = new NativeThreadBindingStore(filePath);
    expect(await restored.getForScope('partner-a', 'single', 'single-a')).toMatchObject({
      personaVersion: 'enabled:persona-v1',
    });
  });

  it('persists the last Studio speaking mode on the active group binding', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-binding-'));
    temporary.push(directory);
    const filePath = path.join(directory, 'bindings.json');
    const bindings = new NativeThreadBindingStore(filePath);
    const pending = await bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'group', conversationId: 'group:v3:room-a:partner-a', roomId: 'room-a' });
    const active = await bindings.activate(pending.bindingId, 'thread-group');

    await bindings.markStudioSpeakingMode(active.bindingId, 'free_discussion');

    const restored = new NativeThreadBindingStore(filePath);
    expect(await restored.getForScope('partner-a', 'group', 'room-a')).toMatchObject({ studioSpeakingMode: 'free_discussion' });
  });

  it('removes only the deleted conversation single binding', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-binding-'));
    temporary.push(directory);
    const bindings = new NativeThreadBindingStore(path.join(directory, 'bindings.json'));
    await bindings.registerSingle({ partnerId: 'partner-a', source: 'api_partner', conversationId: 'single-delete', nativeThreadId: 'thread-delete' });
    await bindings.registerSingle({ partnerId: 'partner-a', source: 'api_partner', conversationId: 'single-keep', nativeThreadId: 'thread-keep' });
    const groupPending = await bindings.reserve({ partnerId: 'partner-a', source: 'api_partner', scope: 'group', conversationId: 'group:room-a:partner-a', roomId: 'room-a' });
    await bindings.activate(groupPending.bindingId, 'thread-group');

    await bindings.removeConversations(['single-delete']);

    expect(await bindings.getForScope('partner-a', 'single', 'single-delete')).toBeUndefined();
    expect(await bindings.getForScope('partner-a', 'single', 'single-keep')).toMatchObject({ nativeThreadId: 'thread-keep' });
    expect(await bindings.getForScope('partner-a', 'group', 'room-a')).toMatchObject({ nativeThreadId: 'thread-group' });
  });

  it('lists and removes workspace bindings by project without touching single or group threads', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-binding-'));
    temporary.push(directory);
    const bindings = new NativeThreadBindingStore(path.join(directory, 'bindings.json'));
    await bindings.registerSingle({ partnerId: 'partner-a', source: 'local_cli', conversationId: 'single-a', nativeThreadId: 'thread-single' });
    const group = await bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'group', conversationId: 'group-a', roomId: 'room-a' });
    await bindings.activate(group.bindingId, 'thread-group');
    const workspace = await bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'workspace', conversationId: 'workspace:v1:project-a:partner-a', projectId: 'project-a' });
    await bindings.activate(workspace.bindingId, 'thread-workspace');

    expect(await bindings.listForProjects(['project-a'])).toEqual([expect.objectContaining({ bindingId: workspace.bindingId })]);
    await bindings.removeProjects(['project-a']);

    expect(await bindings.getForScope('partner-a', 'workspace', 'project-a')).toBeUndefined();
    expect(await bindings.getForScope('partner-a', 'single', 'single-a')).toMatchObject({ nativeThreadId: 'thread-single' });
    expect(await bindings.getForScope('partner-a', 'group', 'room-a')).toMatchObject({ nativeThreadId: 'thread-group' });
  });
});
