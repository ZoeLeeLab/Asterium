import { describe, expect, it, vi } from 'vitest';
import { SessionCommandService } from '../../src/main/runtime/SessionCommandService';
import { WriterLeaseCoordinator, conversationWriterScope } from '../../src/main/runtime/WriterLeaseCoordinator';
import { assertSessionCommandTarget, parseSessionCommand } from '../../src/shared/sessionCommands';
import type { StudioPartnerRecord } from '../../src/main/studio/StudioRuntimeCatalog';
import type { NativeThreadBinding } from '../../src/shared/studioRuntime';
import type { SingleChatConversationSnapshot } from '../../src/shared/singleChatMessages';
import type { PartnerEvent } from '../../src/shared/agentProtocol';

const target = { partnerId: 'p', conversationId: 'c', source: 'api_partner' as const };
function setup() {
  const partner = { partnerId: 'p', sourceMode: 'api_partner', available: true, runtime: { kind: 'api', connection: { model: 'configured' } } } as StudioPartnerRecord;
  let binding: NativeThreadBinding | undefined;
  const indexed: SingleChatConversationSnapshot = { conversationId: 'c', partnerId: 'p', messages: [], permissionMode: 'read_only', planMode: 'plan' };
  const compact = vi.fn(async () => ({ status: 'compacted' as const, message: '已压缩' }));
  const leases = new WriterLeaseCoordinator(), isDeleted = vi.fn(async () => false);
  const service = new SessionCommandService({ catalog: { partner: () => partner }, bindings: { getForScope: vi.fn(async () => binding) }, messages: { getConversation: async () => indexed }, leases, compactions: { compact }, isDeleted });
  return { service, partner, indexed, compact, leases, isDeleted, bind: () => { binding = { nativeThreadId: 's', state: 'active', source: 'api_partner' } as NativeThreadBinding; } };
}
describe('single-chat commands', () => {
  it('recognizes only an independent supported command without attached or quoted content', () => {
    expect(parseSessionCommand(' /status ')).toBe('status'); expect(parseSessionCommand('/compact')).toBe('compact');
    for (const text of ['/status now', '请看 /status', '`/status`', '> /status', '/status\nhello', '/model']) expect(parseSessionCommand(text)).toBeUndefined();
    expect(parseSessionCommand('/status', true)).toBeUndefined(); expect(parseSessionCommand('/status', false, true)).toBeUndefined();
    expect(() => assertSessionCommandTarget({ ...target, path: 'other' })).toThrow('INVALID_SESSION_COMMAND');
    expect(() => assertSessionCommandTarget({ ...target, command: 'shell', commandId: 'cmd' }, true)).toThrow();
  });
  it('queries an empty chat without reserving a binding or executing maintenance', async () => {
    const t = setup(); const result = await t.service.execute({ ...target, command: 'status', commandId: 'cmd' });
    expect(result.session).toMatchObject({ sessionId: undefined, model: 'configured', modelStatus: 'configured', permissionMode: 'read_only', planMode: 'plan', state: 'idle' });
    expect(result.session?.capabilities.compact.available).toBe(false); expect(t.compact).not.toHaveBeenCalled();
  });
  it('isolates the model from another chat and rejects mismatched partner, thread and deleted chat', async () => {
    const t = setup(); t.bind(); t.partner.recentModel = { model: 'other-model', conversationId: 'other', threadId: 's', observedAt: '', source: 'runtime', status: 'recent' };
    expect((await t.service.inspect(target)).model).toBe('configured');
    await expect(t.service.inspect({ ...target, source: 'local_cli' })).rejects.toThrow('PARTNER_MISMATCH');
    await expect(t.service.inspect({ ...target, sessionId: 'other' })).rejects.toThrow('THREAD_MISMATCH');
    t.indexed.partnerId = 'other'; await expect(t.service.inspect(target)).rejects.toThrow('PARTNER_MISMATCH');
    t.isDeleted.mockResolvedValue(true); await expect(t.service.inspect(target)).rejects.toThrow('UNAVAILABLE');
  });
  it('reports waiting interactions from Main events while refusing compact until the writer releases', async () => {
    const t = setup(); t.bind(); const lease = t.leases.tryAcquire(conversationWriterScope(target), 'runtime:cmd')!;
    const base = { partnerId: 'p', conversationId: 'c', runId: 'r', sessionId: 's' };
    t.service.observe({ ...base, type: 'session.bound' } as PartnerEvent);
    t.service.observe({ ...base, type: 'authorization.requested' } as PartnerEvent);
    expect((await t.service.inspect(target)).state).toBe('waiting_authorization');
    await expect(t.service.execute({ ...target, commandId: 'cmd', command: 'compact' })).rejects.toThrow('请等待');
    t.service.observe({ ...base, type: 'authorization.resolved' } as PartnerEvent);
    t.service.observe({ ...base, type: 'user_input.requested' } as PartnerEvent);
    expect((await t.service.inspect(target)).state).toBe('waiting_user_input');
    t.service.observe({ ...base, runId: 'unrelated', type: 'run.completed' } as PartnerEvent);
    expect((await t.service.inspect(target)).state).toBe('waiting_user_input');
    t.service.observe({ ...base, type: 'run.completed' } as PartnerEvent); lease.release();
    await t.service.execute({ ...target, sessionId: 's', commandId: 'cmd', command: 'compact' }); expect(t.compact).toHaveBeenCalledOnce();
  });
  it('keeps maintenance and native unsupported/history-disabled/archive reasons explicit', async () => {
    const t = setup(); t.bind(); t.indexed.apiSessionHistoryEnabled = false;
    expect((await t.service.inspect(target)).capabilities.compact.reason).toContain('会话记录');
    t.indexed.apiSessionHistoryEnabled = true; t.indexed.isArchived = true;
    await expect(t.service.execute({ ...target, commandId: 'cmd', command: 'compact' })).rejects.toThrow('恢复');
    t.indexed.isArchived = false; const lease = t.leases.tryAcquire(conversationWriterScope(target), 'compact:cmd')!;
    expect((await t.service.inspect(target)).state).toBe('maintenance'); lease.release();
    t.partner.available = false; expect((await t.service.inspect(target)).capabilities.status.available).toBe(true);
  });
});
