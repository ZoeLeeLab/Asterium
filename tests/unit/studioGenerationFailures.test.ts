import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { AdapterHost } from '../../src/main/AdapterHost';
import type { PartnerAdapter } from '../../src/main/adapters/PartnerAdapter';
import { RunCoordinator } from '../../src/main/runtime/RunCoordinator';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import { AGENT_PROTOCOL_VERSION, type SendMessageCommand } from '../../src/shared/agentProtocol';

it.each(['start', 'stream'])('a delayed %s failure cannot invalidate a rejoined member', async (stage) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-group-race-'));
  try {
    const bindings = new NativeThreadBindingStore(path.join(root, 'bindings.json'));
    const input = { partnerId: 'p', source: 'api_partner' as const, scope: 'group' as const, roomId: 'r', conversationId: 'group:v3:r:p', generationScopedConversation: true };
    const first = await bindings.reserve(input); await bindings.activate(first.bindingId, 'old-thread');
    const command: SendMessageCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'cmd', partnerId: 'p', conversationId: first.conversationId, connectionSource: 'api_partner', clientMessageId: 'm',
      route: { scope: 'group', roomId: 'r', roundId: 'old-round', bindingGeneration: first.generation, inputThroughSeq: 1 }, content: { type: 'text', text: 'old' } };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cleanup = vi.fn((failed: SendMessageCommand) => bindings.invalidateGroupTurn(failed));
    const coordinator = new RunCoordinator(new AdapterHost(), {
      deliver: vi.fn(), emit: vi.fn(), observe: async () => undefined,
      onStartFailure: (_error, failed) => cleanup(failed), onStreamFailure: (_error, context) => cleanup(context.command),
    });
    const adapter: PartnerAdapter = {
      connectionSource: 'api_partner',
      capabilities: { streamingText: true, cancellation: true, sessionResume: true, toolEvents: true, fileEvents: true, authorizationBridge: true, extensions: [] },
      async *resumeSession() { yield* []; }, resolveAuthorization: vi.fn(), cancel: vi.fn(),
      async *sendMessage() {
      if (stage === 'start') { await gate; throw new Error('late start failure'); }
      yield { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'session.bound', eventId: 'bound', partnerId: 'p', conversationId: first.conversationId, connectionSource: 'api_partner', clientMessageId: 'm', sessionId: 'old-thread', runId: 'run', sequence: 1, occurredAt: '2026-10-23T12:00:00.000Z', isNew: false };
      await gate; throw new Error('late stream failure');
    } };
    const started = coordinator.start(adapter, command); void started.catch(() => undefined);
    if (stage === 'stream') await started;
    await bindings.invalidateRoomMembers('r', ['p']);
    const fresh = await bindings.reserve(input); await bindings.activate(fresh.bindingId, 'new-thread');
    release();
    if (stage === 'start') await expect(started).rejects.toThrow('late start failure');
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    // Wait for the persistent cleanup, not only its invocation.
    await cleanup.mock.results[0].value;
    expect(await bindings.getForScope('p', 'group', 'r')).toMatchObject({ bindingId: fresh.bindingId, nativeThreadId: 'new-thread', state: 'active' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
