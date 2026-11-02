// @vitest-environment node
import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import type { ApiProviderAdapter, ApiProviderStreamEvent } from '../../src/main/api/ApiProviderAdapter';
import { ExecutionBackendRouter } from '../../src/main/execution/ExecutionBackendRouter';
import { issueNativeCommandApproval, type NativeCommandApproval } from '../../src/main/execution/NativeCommandApproval';
import type { CommandLaunchRequest, ExtensionLaunchBackend } from '../../src/main/api/extensions/ExtensionLaunchBackend';
import type { ExecutionContext } from '../../src/main/execution/ExecutionContext';
import type { PartnerEvent, SendMessageCommand } from '../../src/shared/agentProtocol';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const context: ExecutionContext = { kind: 'partner_runtime', partnerId: 'p', conversationId: 'c', policy: { permissionMode: 'manual', planMode: 'default' }, workspace: { workspaceFolders: ['K:\\work'] } };
const base = { command: 'echo literal', cwd: 'K:\\work', context, signal: new AbortController().signal, beforeStart: async () => undefined };

function backends() {
  const make = (sandboxed: boolean) => ({ id: sandboxed ? 'sandbox' : 'native', sandboxed,
    runCommand: vi.fn(async (request: CommandLaunchRequest) => { request.onStarted?.({ backend: sandboxed ? 'sandbox' : 'native', sandboxed }); return 'OK'; }),
    launchSkillScript: vi.fn(), createMcpTransport: vi.fn(() => ({})),
  }) as unknown as ExtensionLaunchBackend & { runCommand: ReturnType<typeof vi.fn<(request: CommandLaunchRequest) => Promise<string>>> };
  const native = make(false), sandbox = make(true);
  const settings = { sandboxEnabled: true, sandboxAllowNetwork: false };
  return { native, sandbox, settings, router: new ExecutionBackendRouter(async () => settings, sandbox, native) };
}

it('consumes an exact command approval once; later commands and MCP remain sandboxed', async () => {
  const f = backends(), nativeApproval = issueNativeCommandApproval(base);
  await expect(f.router.runCommand({ ...base, nativeApproval })).resolves.toBe('OK');
  await expect(f.router.runCommand({ ...base, nativeApproval })).rejects.toThrow('NATIVE_COMMAND_APPROVAL_INVALID');
  await f.router.runCommand(base);
  await f.router.createMcpTransport({ context, configuration: { type: 'mcp_stdio', command: 'node', args: [] }, secrets: {}, signal: base.signal });
  expect(f.native.runCommand).toHaveBeenCalledOnce(); expect(f.sandbox.runCommand).toHaveBeenCalledOnce(); expect(f.sandbox.createMcpTransport).toHaveBeenCalledOnce();
  expect(f.settings).toEqual({ sandboxEnabled: true, sandboxAllowNetwork: false });
});
it.each(['command', 'cwd', 'identity', 'policy', 'workspace', 'forged'] as const)('rejects changed or forged approval: %s', async change => {
  const f = backends(), request = { ...structuredClone({ command: base.command, cwd: base.cwd, context }), signal: base.signal, beforeStart: base.beforeStart, nativeApproval: issueNativeCommandApproval(base) };
  if (change === 'command') request.command += ' changed';
  if (change === 'cwd') request.cwd += '\\other';
  if (request.context.kind === 'partner_runtime') {
    if (change === 'identity') request.context.partnerId = 'other';
    if (change === 'policy') request.context.policy!.permissionMode = 'automatic';
    if (change === 'workspace') request.context.workspace!.workspaceFolders = ['K:\\other'];
  }
  if (change === 'forged') request.nativeApproval = {} as NativeCommandApproval;
  await expect(f.router.runCommand(request)).rejects.toThrow('NATIVE_COMMAND_APPROVAL_INVALID');
  expect(f.native.runCommand).not.toHaveBeenCalled(); expect(f.sandbox.runCommand).not.toHaveBeenCalled();
});
it('revalidates an approved Native command before dispatch and never retries a failure', async () => {
  const f = backends();
  await expect(f.router.runCommand({ ...base, nativeApproval: issueNativeCommandApproval(base), beforeStart: async () => { throw new Error('REVOKED'); } })).rejects.toThrow('REVOKED');
  expect(f.native.runCommand).not.toHaveBeenCalled();
  f.native.runCommand.mockRejectedValueOnce(new Error('NATIVE_FAILED'));
  await expect(f.router.runCommand({ ...base, nativeApproval: issueNativeCommandApproval(base) })).rejects.toThrow('NATIVE_FAILED');
  expect(f.native.runCommand).toHaveBeenCalledOnce(); expect(f.sandbox.runCommand).not.toHaveBeenCalled();
});
it('holds an immutable approved intent while awaiting settings', async () => {
  const f = backends(); let ready!: () => void;
  const router = new ExecutionBackendRouter(() => new Promise(resolve => { ready = () => resolve(f.settings); }), f.sandbox, f.native);
  const request = { ...base, context: structuredClone(context), nativeApproval: issueNativeCommandApproval(base) };
  const running = router.runCommand(request);
  request.command = 'unapproved'; request.cwd = 'K:\\other';
  if (request.context.kind === 'partner_runtime') request.context.partnerId = 'other';
  ready(); await running;
  expect(f.native.runCommand.mock.calls[0][0]).toMatchObject({ command: base.command, cwd: base.cwd, context });
});

async function setup(calls: Record<string, unknown>[], mode: 'manual' | 'automatic' | 'full' | 'read_only' = 'manual', planMode: 'plan' | 'default' = 'default') {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-approval-')); directories.push(cwd);
  const f = backends(); let roots = [cwd]; let round = 0;
  const provider: ApiProviderAdapter = { provider: 'synthetic', capabilities: { streamingText: true, reasoning: false, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } },
    async *stream() {
      const args = calls[round++];
      const events: ApiProviderStreamEvent[] = args ? [{ type: 'tool.delta', index: 0, id: `call-${round}`, name: 'run_command', arguments: JSON.stringify({ command: 'Write-Output OK', cwd, ...args }) }, { type: 'finish', reason: 'tool_calls' }] : [{ type: 'finish', reason: 'stop' }];
      yield* events;
    } };
  const tools = new ApiAgentTools(cwd, [], undefined, { status: async () => JSON.stringify({ workspaceFolders: roots }), workspace: async () => '{}', update() {} }, undefined, [], f.router, { partnerId: 'p', conversationId: 'c' });
  const runtime = new ApiAgentRuntime({ provider, tools, toolsEnabled: true });
  const input: SendMessageCommand = { protocolVersion: 2, type: 'message.send', commandId: 'cmd', partnerId: 'p', conversationId: 'c', clientMessageId: 'client', connectionSource: 'api_partner', content: { type: 'text', text: 'synthetic test only' }, execution: { permissionMode: mode, planMode }, apiContext: { history: [], apiSessionHistoryEnabled: false } };
  const events: PartnerEvent[] = [];
  const collect = async (onApproval: (event: Extract<PartnerEvent, { type: 'authorization.requested' }>) => Promise<void>) => {
    for await (const event of runtime.sendMessage(input)) { events.push(event); if (event.type === 'authorization.requested') await onApproval(event); if (event.type === 'user_input.requested') await runtime.cancel({ ...input, type: 'run.cancel', sessionId: event.sessionId, runId: event.runId }); }
    return events;
  };
  const answer = (event: Extract<PartnerEvent, { type: 'authorization.requested' }>, decision: 'allow_once' | 'deny' = 'allow_once') => runtime.resolveAuthorization({ ...input, type: 'authorization.resolve', sessionId: event.sessionId, runId: event.runId, authorizationId: event.authorizationId, decision });
  return { ...f, cwd, runtime, input, collect, answer, events, revoke: () => { roots = []; } };
}
const escalated = { sandbox_permissions: 'require_escalated', justification: 'Only this synthetic command needs Native.' };
it.each(['manual', 'automatic'] as const)('requires separate approval in %s and restores default routing on the next call', async mode => {
  const f = await setup([escalated, {}], mode);
  let approvals = 0;
  await f.collect(async event => {
    if (approvals++ === 0) { expect(event.purpose).toBe('command_native'); expect(f.native.runCommand).not.toHaveBeenCalled(); expect(event.targets).toContain('理由: Only this synthetic command needs Native.'); }
    await f.answer(event);
  });
  expect(approvals).toBe(2); expect(f.native.runCommand).toHaveBeenCalledOnce(); expect(f.sandbox.runCommand).toHaveBeenCalledOnce();
  expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.completed', detail: expect.stringContaining('"backend":"native","sandboxed":false') })]));
});
it.each(['deny', 'cancel', 'revoke'] as const)('does not execute after %s while approval is pending', async action => {
  const f = await setup([escalated]);
  await f.collect(async event => {
    expect(f.native.runCommand).not.toHaveBeenCalled();
    if (action === 'cancel') await f.runtime.cancel({ ...f.input, type: 'run.cancel', sessionId: event.sessionId, runId: event.runId });
    else { if (action === 'revoke') f.revoke(); await f.answer(event, action === 'deny' ? 'deny' : 'allow_once'); }
  });
  expect(f.native.runCommand).not.toHaveBeenCalled(); expect(f.sandbox.runCommand).not.toHaveBeenCalled();
});
it('Full remains Native without approval even when explicitly requested', async () => {
  const f = await setup([escalated], 'full');
  await f.collect(async () => { throw new Error('unexpected approval'); });
  expect(f.native.runCommand).toHaveBeenCalledOnce(); expect(f.sandbox.runCommand).not.toHaveBeenCalled();
});
it.each([['read_only', 'default'], ['manual', 'plan']] as const)('does not bypass %s/%s', async (mode, plan) => {
  const f = await setup([escalated], mode, plan);
  await f.collect(async () => { throw new Error('unexpected approval'); });
  expect(f.native.runCommand).not.toHaveBeenCalled(); expect(f.sandbox.runCommand).not.toHaveBeenCalled();
});
it('offers a fresh approval after confirmed pre-start refusal, not an automatic Native retry', async () => {
  const f = await setup([{}, escalated]); f.sandbox.runCommand.mockRejectedValueOnce(new Error('SANDBOX_ELEVATED_HOST_REFUSED'));
  await f.collect(async event => { if (event.purpose === 'command_native') expect(f.native.runCommand).not.toHaveBeenCalled(); await f.answer(event); });
  expect(f.sandbox.runCommand).toHaveBeenCalledOnce(); expect(f.native.runCommand).toHaveBeenCalledOnce();
});
it('blocks Native replay in the same turn after an uncertain command failure', async () => {
  const f = await setup([{}, escalated]); f.sandbox.runCommand.mockRejectedValueOnce(new Error('TOOL_COMMAND_FAILED:1:partial'));
  let approvals = 0; await f.collect(async event => { approvals++; await f.answer(event); });
  expect(approvals).toBe(1); expect(f.native.runCommand).not.toHaveBeenCalled();
  expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.completed', detail: expect.stringContaining('NATIVE_COMMAND_REPLAY_REQUIRES_NEW_TURN') })]));
});
it('rejects a Native request without a reason before presenting approval', async () => {
  const f = await setup([{ sandbox_permissions: 'require_escalated' }]);
  await f.collect(async () => { throw new Error('unexpected approval'); });
  expect(f.native.runCommand).not.toHaveBeenCalled(); expect(f.sandbox.runCommand).not.toHaveBeenCalled();
});
