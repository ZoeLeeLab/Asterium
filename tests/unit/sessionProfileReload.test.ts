import { expect, it, vi } from 'vitest';
import { assembleSessionBootstrap } from '../../src/main/runtime/SessionBootstrapAssembler';
import { appliedProfiles, replaceProfile } from '../../src/main/runtime/AppliedSessionProfiles';
import { SessionProfileReloadService } from '../../src/main/runtime/SessionProfileReloadService';
import { WriterLeaseCoordinator, conversationWriterScope } from '../../src/main/runtime/WriterLeaseCoordinator';
import { confirmProfileReload } from '../../src/main/api/confirmProfileReload';
import type { ApiProviderAdapter } from '../../src/main/api/ApiProviderAdapter';
import type { NativeThreadBinding } from '../../src/shared/studioRuntime';
import type { SessionCommandRequest } from '../../src/shared/sessionCommands';

const request: SessionCommandRequest = { commandId: 'reload-one', command: 'reload-user', partnerId: 'p', conversationId: 'c', sessionId: 's', source: 'api_partner' };
const bootstrap = () => assembleSessionBootstrap({ source: 'api_partner', partnerName: '伙伴', management: { userProfile: true, personality: true, memoryMode: 'self_managed' }, user: { displayName: '旧用户', introduction: '旧介绍' }, persona: { personality: '旧人设', systemPrompt: '旧指令', version: 'persona-old' }, platformContext: '原平台规则', memoryBriefing: '旧记忆' })!;
function setup() {
  const binding = { bindingId: 'b', nativeThreadId: 's', source: 'api_partner', state: 'active', bootstrap: bootstrap() } as NativeThreadBinding;
  const mark = vi.fn(async (_id, _version, _schema, document) => { binding.bootstrap = document; return binding; });
  const confirm = vi.fn(async () => ({ message: '已确认', commit: vi.fn(), rollback: vi.fn() }));
  const leases = new WriterLeaseCoordinator();
  const profiles = { runtimeProfile: vi.fn(async () => ({ publicIdentity: { displayName: '', introduction: '', expertise: '', mentionName: '' }, management: { userProfile: true, personality: true, memoryMode: 'self_managed' as const } })), runtimeUserProfile: vi.fn(async () => ({ displayName: '新用户', introduction: '新介绍', updatedAt: '' })), managedPersonaState: vi.fn(async () => ({ enabled: true as const, personaFileExists: true, personality: '新人设', systemPrompt: '新指令', version: 'persona-new' })) };
  const service = new SessionProfileReloadService({ leases, profiles, bindings: { getForScope: vi.fn(async () => binding), markPersonaVersion: mark, setProfileRecoveryRequired: vi.fn() }, validate: vi.fn(async () => undefined), confirm });
  return { binding, mark, confirm, leases, profiles, service };
}
it('replaces only the selected complete profile, preserving platform/time/other profile and developer data boundaries', () => {
  const original = bootstrap(), profiles = appliedProfiles(original); profiles.user = { enabled: true, displayName: '新用户', introduction: '新介绍', version: 'new' };
  const next = replaceProfile(original, 'user', profiles);
  expect(next.content).toContain('新用户'); expect(next.content).not.toContain('旧用户');
  expect(next.content).toContain('旧人设'); expect(next.content).toContain('原平台规则'); expect(next.createdAt).toBe(original.createdAt);
  expect(next.developerContent).toContain('kind":"reference'); expect(next.developerContent).not.toContain('旧用户');
  expect(appliedProfiles(next).persona?.version).toBe('persona-old');
});
it('recovers reliable legacy reference JSON without consulting new files, leaving opaque legacy versions unknown', () => {
  const old = bootstrap(); delete old.appliedProfiles; delete old.profileSections;
  expect(appliedProfiles(old)).toMatchObject({ user: { displayName: '旧用户' }, persona: { personality: '旧人设' } });
  expect(appliedProfiles({ version: 1, content: 'opaque', createdAt: '', timeZone: '' })).toEqual({});
  expect(replaceProfile(old, 'persona', { ...appliedProfiles(old), persona: { enabled: false, version: 'disabled' } }).content).not.toContain('旧人设');
});
it('commits after confirmation, reads only selected profile and deduplicates the same operation', async () => {
  const t = setup(); const a = t.service.execute(request), b = t.service.execute(request); expect(a).toBe(b);
  await a; expect(t.mark).toHaveBeenCalledOnce(); expect(t.confirm).toHaveBeenCalledOnce(); expect(t.profiles.managedPersonaState).not.toHaveBeenCalled();
  expect(t.binding.bootstrap?.content).toContain('新用户'); expect(t.binding.bootstrap?.content).toContain('旧人设');
  expect(t.leases.ownerFor(conversationWriterScope(request))).toBeUndefined();
  await expect(t.service.execute({ ...request, command: 'reload-persona' })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
});
it('keeps previous versions on failed confirmation and refuses an active writer', async () => {
  const t = setup(), original = structuredClone(t.binding.bootstrap); t.confirm.mockRejectedValueOnce(new Error('network'));
  await expect(t.service.execute(request)).rejects.toThrow('network'); expect(t.binding.bootstrap).toEqual(original); expect(t.mark).not.toHaveBeenCalled();
  const lease = t.leases.tryAcquire(conversationWriterScope(request), 'runtime:one')!;
  await expect(t.service.execute({ ...request, commandId: 'two' })).rejects.toThrow('BUSY'); lease.release();
});
it('rolls back a confirmed operation if the durable binding cannot commit', async () => {
  const t = setup(); const rollback = vi.fn(); t.confirm.mockResolvedValueOnce({ message: '确认', commit: vi.fn(), rollback }); t.mark.mockRejectedValueOnce(new Error('disk'));
  await expect(t.service.execute(request)).rejects.toThrow('disk'); expect(rollback).toHaveBeenCalledOnce();
});
it('updates persona without reading the user MD', async () => {
  const t = setup(); await t.service.execute({ ...request, command: 'reload-persona' });
  expect(t.profiles.runtimeUserProfile).not.toHaveBeenCalled(); expect(t.binding.bootstrap?.content).toContain('新人设'); expect(t.binding.bootstrap?.content).toContain('旧用户');
});
it('uses a tool-free confirmation and rejects tool calls, partial output or aborts', async () => {
  const provider = { stream: vi.fn(async function* () { yield { type: 'text.delta' as const, text: '已重读' }; yield { type: 'finish' as const, reason: 'stop' }; }) } as unknown as ApiProviderAdapter;
  expect(await confirmProfileReload(provider, 'user', bootstrap(), new AbortController().signal)).toBe('已重读');
  expect(provider.stream).toHaveBeenCalledWith(expect.objectContaining({ tools: [], messages: expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('旧用户') })]) }));
  const bad = { ...provider, stream: async function* () { yield { type: 'tool.delta' as const, index: 0 }; } };
  await expect(confirmProfileReload(bad, 'user', bootstrap(), new AbortController().signal)).rejects.toThrow('UNEXPECTED_TOOL');
  const aborted = AbortSignal.abort(); await expect(confirmProfileReload(provider, 'user', bootstrap(), aborted)).rejects.toThrow();
});
