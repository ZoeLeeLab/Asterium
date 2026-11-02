// @vitest-environment node
import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/main/adapters/ClaudeCodeAdapter';
import { confirmNativeProfileReload } from '../../src/main/runtime/NativeProfileReload';
import { SessionProfileReloadService } from '../../src/main/runtime/SessionProfileReloadService';
import { SessionBootstrapService } from '../../src/main/runtime/SessionBootstrapService';
import { SessionCommandService } from '../../src/main/runtime/SessionCommandService';
import { assembleSessionBootstrap } from '../../src/main/runtime/SessionBootstrapAssembler';
import { conversationWriterScope, WriterLeaseCoordinator } from '../../src/main/runtime/WriterLeaseCoordinator';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import type { StudioPartnerRecord } from '../../src/main/studio/StudioRuntimeCatalog';
import type { SendMessageCommand } from '../../src/shared/agentProtocol';
import type { SessionCommandRequest } from '../../src/shared/sessionCommands';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/main/adapters/ClaudeCliTransport', () => ({ query: sdk.query }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const request: SessionCommandRequest = { commandId: 'reload', command: 'reload-user', partnerId: 'p', conversationId: 'c', sessionId: 's', source: 'local_cli' };

async function setup(outcomes: Array<'success' | 'failed' | 'tool'>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-recovery-')); roots.push(root);
  const file = path.join(root, 'bindings.json'), bindings = new NativeThreadBindingStore(file), leases = new WriterLeaseCoordinator();
  const binding = await bindings.registerSingle({ partnerId: 'p', conversationId: 'c', nativeThreadId: 's', source: 'local_cli' });
  const previous = assembleSessionBootstrap({ source: 'local_cli', partnerName: '伙伴', management: { userProfile: true, personality: true, memoryMode: 'self_managed' },
    user: { displayName: '旧用户', introduction: '旧介绍' }, persona: { personality: '旧人设', systemPrompt: '旧指令', version: 'old-persona' } })!;
  await bindings.markPersonaVersion(binding.bindingId, 'old-persona', 1, previous);
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  sdk.query.mockClear();
  sdk.query.mockImplementation((input: { prompt: string; options: Record<string, unknown> }) => {
    calls.push(input); const outcome = outcomes.shift() ?? 'success';
    return Object.assign((async function* () {
      yield { type: 'assistant', session_id: 's', message: { content: outcome === 'tool' ? [{ type: 'tool_use', name: 'Write' }] : [{ type: 'text', text: '已确认' }] } };
      yield { type: 'result', subtype: outcome === 'failed' ? 'error_during_execution' : 'success', session_id: 's' };
    })(), { close: vi.fn() });
  });
  const profiles = {
    runtimeProfile: vi.fn(async () => ({ publicIdentity: { displayName: '伙伴', introduction: '', expertise: '', mentionName: '伙伴' }, management: { userProfile: true, personality: true, memoryMode: 'self_managed' as const } })),
    runtimeUserProfile: vi.fn(async () => ({ displayName: '新用户', introduction: '新介绍', updatedAt: '' })),
    managedPersonaState: vi.fn(async () => ({ enabled: true as const, personaFileExists: true, personality: '新人设', systemPrompt: '新指令', version: 'new-persona' })),
  };
  const adapter = new ClaudeCodeAdapter('unused-by-mock', root);
  const createService = (store = bindings) => new SessionProfileReloadService({ bindings: store, profiles, leases, validate: async () => undefined,
    confirm: async (_request, kind, old, next, signal, recoverFirst) => {
      expect((await store.getForScope('p', 'single', 'c'))?.profileRecoveryRequired).toBe(true);
      return confirmNativeProfileReload(adapter, 's', kind, old, next, signal, recoverFirst);
    } });
  return { bindings, binding, file, profiles, leases, previous, calls, adapter, createService, service: createService() };
}

it.each(['failed', 'tool'] as const)('restores the same Claude session after a %s confirmation with tools disabled', async (outcome) => {
  const t = await setup([outcome, 'success']);
  await expect(t.service.execute(request)).rejects.toThrow(outcome === 'tool' ? 'UNEXPECTED_TOOL' : 'INCOMPLETE');
  expect(t.calls).toHaveLength(2); expect(t.calls[0].prompt).toContain('新介绍');
  expect(t.calls[1].prompt).toContain('旧介绍'); expect(t.calls[1].prompt).toContain('旧人设'); expect(t.calls[1].prompt).not.toContain('新介绍');
  for (const call of t.calls) expect(call.options).toMatchObject({ resume: 's', tools: [], mcpServers: {}, strictMcpConfig: true, permissionMode: 'dontAsk', settings: { disableAllHooks: true } });
  expect(await t.bindings.getForScope('p', 'single', 'c')).toMatchObject({ bootstrap: t.previous, profileRecoveryRequired: false });
  expect(t.leases.ownerFor(conversationWriterScope(request))).toBeUndefined();
});

it('compensates a successful native confirmation when the binding commit fails', async () => {
  const t = await setup(['success', 'success']);
  vi.spyOn(t.bindings, 'markPersonaVersion').mockRejectedValueOnce(new Error('disk-failed'));
  await expect(t.service.execute(request)).rejects.toThrow('disk-failed');
  expect(t.calls).toHaveLength(2); expect(t.calls[1].prompt).toContain('旧介绍');
  expect(await t.bindings.getForScope('p', 'single', 'c')).toMatchObject({ bootstrap: t.previous, profileRecoveryRequired: false });
});

it.each(['confirmation', 'commit'])('persists failed compensation after %s, blocks resume/compact, and restores before retry after restart', async (stage) => {
  const t = await setup([stage === 'confirmation' ? 'failed' : 'success', 'failed', 'success', 'success']);
  if (stage === 'commit') vi.spyOn(t.bindings, 'markPersonaVersion').mockRejectedValueOnce(new Error('disk-failed'));
  await expect(t.service.execute(request)).rejects.toThrow('PROFILE_RELOAD_RECOVERY_REQUIRED');
  const restarted = new NativeThreadBindingStore(t.file);
  expect(await restarted.getForScope('p', 'single', 'c')).toMatchObject({ bootstrap: t.previous, profileRecoveryRequired: true });
  const bootstrap = new SessionBootstrapService(t.profiles, { get: vi.fn() }, restarted, { getRoom: vi.fn() });
  await expect(bootstrap.prepare({ partnerId: 'p', conversationId: 'c', connectionSource: 'local_cli', sessionId: 's' } as SendMessageCommand)).rejects.toThrow('PROFILE_RELOAD_RECOVERY_REQUIRED');
  const commands = new SessionCommandService({ bindings: restarted, leases: t.leases, catalog: { partner: () => ({ sourceMode: 'local_cli', available: true, runtime: { kind: 'local' } }) as StudioPartnerRecord },
    messages: { getConversation: async () => ({ conversationId: 'c', partnerId: 'p', messages: [] }) }, compactions: { compact: vi.fn() }, isDeleted: async () => false });
  const status = await commands.inspect({ partnerId: 'p', conversationId: 'c', source: 'local_cli' });
  expect(status.profileRecoveryRequired).toBe(true); expect(status.capabilities.compact.available).toBe(false); expect(status.capabilities['reload-user'].available).toBe(true);
  await expect(t.createService(restarted).execute({ ...request, commandId: 'retry' })).resolves.toMatchObject({ status: 'success' });
  expect(t.calls).toHaveLength(4); expect(t.calls[2].prompt).toContain('旧介绍'); expect(t.calls[3].prompt).toContain('新介绍');
  expect(await restarted.getForScope('p', 'single', 'c')).toMatchObject({ profileRecoveryRequired: false, bootstrap: { appliedProfiles: { user: { displayName: '新用户' }, persona: { personality: '旧人设' } } } });
});

it('does not contact Claude if the durable recovery marker cannot be written', async () => {
  const t = await setup([]);
  vi.spyOn(t.bindings, 'setProfileRecoveryRequired').mockRejectedValueOnce(new Error('marker-write-failed'));
  await expect(t.service.execute(request)).rejects.toThrow('marker-write-failed');
  expect(t.calls).toHaveLength(0); expect(t.leases.ownerFor(conversationWriterScope(request))).toBeUndefined();
});

it('keeps the writer until compensation finishes and uses a fresh signal after cancellation', async () => {
  const t = await setup([]);
  let restoreStarted = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  sdk.query.mockImplementationOnce(() => Object.assign((async function* () {
    await new Promise(() => undefined); yield undefined;
  })(), { close: vi.fn() }));
  sdk.query.mockImplementationOnce((input: { options: { abortController: AbortController } }) => {
    restoreStarted = true; expect(input.options.abortController.signal.aborted).toBe(false);
    return Object.assign((async function* () {
      yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: '已恢复' }] } };
      await gate; yield { type: 'result', subtype: 'success', session_id: 's' };
    })(), { close: vi.fn() });
  });
  const running = t.service.execute(request); void running.catch(() => undefined);
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());
  t.service.dispose();
  await vi.waitFor(() => expect(restoreStarted).toBe(true));
  expect(t.leases.ownerFor(conversationWriterScope(request))).toBe('reload:reload');
  expect((await t.bindings.getForScope('p', 'single', 'c'))?.profileRecoveryRequired).toBe(true);
  release(); await expect(running).rejects.toThrow();
  expect(t.leases.ownerFor(conversationWriterScope(request))).toBeUndefined();
  expect(await t.bindings.getForScope('p', 'single', 'c')).toMatchObject({ bootstrap: t.previous, profileRecoveryRequired: false });
});

it('keeps recovery required when a previously interrupted reload cannot restore the old snapshot', async () => {
  const t = await setup(['failed']); await t.bindings.setProfileRecoveryRequired(t.binding.bindingId, true);
  await expect(t.service.execute(request)).rejects.toThrow('PROFILE_RELOAD_RECOVERY_REQUIRED');
  expect(t.calls).toHaveLength(1); expect(t.calls[0].prompt).toContain('旧介绍'); expect(t.calls[0].prompt).not.toContain('新介绍');
  expect((await t.bindings.getForScope('p', 'single', 'c'))?.profileRecoveryRequired).toBe(true);
});
