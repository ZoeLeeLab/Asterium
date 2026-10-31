import type { NativeThreadBinding } from '../../src/shared/studioRuntime';
import { expect, it, vi } from 'vitest';
import type { PartnerEvent, SendMessageCommand } from '../../src/shared/agentProtocol';
import { SessionBootstrapRecorder } from '../../src/main/runtime/SessionBootstrapRecorder';

it('ignores a late bound event after the group member has rejoined a new generation', async () => {
  const binding = { bindingId: 'new', generation: 2, conversationId: 'group-new', nativeThreadId: 'new-thread' } as NativeThreadBinding;
  const bindings = { getForScope: vi.fn(async () => binding), registerSingle: vi.fn(), markPersonaVersion: vi.fn() };
  const recorder = new SessionBootstrapRecorder(bindings);
  const command = { partnerId: 'p', conversationId: 'group-old', connectionSource: 'api_partner', route: { scope: 'group', roomId: 'r', roundId: 'old-round', bindingGeneration: 1, inputThroughSeq: 1 },
    sessionBootstrap: { version: 1, content: '旧代次资料', createdAt: '', timeZone: '' } } as SendMessageCommand;
  await recorder.onBound({ type: 'session.bound', sessionId: 'old-thread' } as Extract<PartnerEvent, { type: 'session.bound' }>, command);
  await recorder.onEvent({ type: 'message.accepted' } as PartnerEvent, command);
  expect(bindings.markPersonaVersion).not.toHaveBeenCalled();
  command.conversationId = binding.conversationId; command.route = { ...command.route!, bindingGeneration: 2 } as SendMessageCommand['route'];
  await recorder.onBound({ type: 'session.bound', sessionId: 'new-thread' } as Extract<PartnerEvent, { type: 'session.bound' }>, command);
  await recorder.onEvent({ type: 'message.accepted' } as PartnerEvent, command);
  expect(bindings.markPersonaVersion).toHaveBeenCalledWith('new', 'disabled', 1, command.sessionBootstrap);
});

it('does not turn an already accepted native run into a retryable send failure when bookkeeping cannot write', async () => {
  const bindings = { getForScope: vi.fn(), registerSingle: vi.fn(async () => ({ bindingId: 'b' } as NativeThreadBinding)), markPersonaVersion: vi.fn(async () => { throw new Error('disk'); }) };
  const recorder = new SessionBootstrapRecorder(bindings);
  const command = { connectionSource: 'local_cli', sessionBootstrap: { version: 1, content: '原资料', createdAt: '', timeZone: '' } } as SendMessageCommand;
  const event = { type: 'session.bound', sessionId: 's' } as Extract<PartnerEvent, { type: 'session.bound' }>;
  await recorder.onBound(event, command);
  await expect(recorder.onEvent({ ...event, type: 'message.accepted' }, command)).resolves.toBeUndefined();
  bindings.registerSingle.mockRejectedValueOnce(new Error('disk'));
  await expect(recorder.onBound(event, command)).resolves.toBeUndefined();
});

it('records only accepted snapshots and never queries current persona data', async () => {
  const bindings = { getForScope: vi.fn(), registerSingle: vi.fn(async () => ({ bindingId: 'b' } as NativeThreadBinding)), markPersonaVersion: vi.fn() };
  const recorder = new SessionBootstrapRecorder(bindings);
  const command = { partnerId: 'p', conversationId: 'c', connectionSource: 'local_cli', sessionBootstrap: { version: 1, content: '原资料', createdAt: '', timeZone: '', personaVersion: 'one' } } as SendMessageCommand;
  const event = { type: 'session.bound', sessionId: 's' } as PartnerEvent;
  await recorder.onBound(event as Extract<PartnerEvent, { type: 'session.bound' }>, command);
  expect(bindings.markPersonaVersion).not.toHaveBeenCalled();
  await recorder.onEvent({ ...event, type: 'message.accepted' }, command);
  expect(bindings.markPersonaVersion).toHaveBeenCalledWith('b', 'one', 1, command.sessionBootstrap);
});
it('does not replace an existing snapshot on ordinary continuation', async () => {
  const bindings = { getForScope: vi.fn(), registerSingle: vi.fn(async () => ({ bindingId: 'b', bootstrap: { version: 1, content: '原资料', createdAt: '', timeZone: '' } } as NativeThreadBinding)), markPersonaVersion: vi.fn() };
  const recorder = new SessionBootstrapRecorder(bindings);
  const command = { connectionSource: 'api_partner', sessionId: 's', sessionBootstrap: { version: 1, content: '原资料', createdAt: '', timeZone: '' } } as SendMessageCommand;
  await recorder.onBound({ type: 'session.bound', sessionId: 's' } as Extract<PartnerEvent, { type: 'session.bound' }>, command);
  await recorder.onEvent({ type: 'message.accepted' } as PartnerEvent, command);
  expect(bindings.markPersonaVersion).not.toHaveBeenCalled();
});
