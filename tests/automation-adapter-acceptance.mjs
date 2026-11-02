import { runAutoTest, testRm as rm, buildTestSdk } from './helpers/autoTest.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

await runAutoTest(async () => {
const { AutomationAdapterSession, automationAdapterCapabilitiesSchema, automationAdapterReceiptSchema, automationAdapterTriggerSchema } = await buildTestSdk('vite.automation-adapter.config.ts', 'automation-adapter.mjs');
// Reference contract acceptance. --mock never starts a model. Real-host mode is read-only unless --dispatch is explicit.







const flags = process.argv.slice(2), option = name => { const at = flags.indexOf(name); return at < 0 ? undefined : flags[at + 1]; };
const signal = () => AbortSignal.timeout(8000);
const cases = [];
const triggerFor = binding => ({ protocolVersion: 1, source: 'asterium', type: 'asterium.automation', triggerId: randomUUID(), occurrenceId: randomUUID(), automationId: 'acceptance-only',
  scheduledAt: new Date().toISOString(), name: '原线程验收', instructions: '这是用户明确发起的验收。仅回复验收完成，不修改文件，不发布到微信，不创建其他任务。', binding,
  delivery: 'original_conversation_only', allowNewThread: false, echoToWeChat: false });
if (flags.includes('--mock')) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-auto-adapter-'));
  const binding = { adapterId: 'fixture', partnerId: 'chuan', conversationId: 'original', sourceMode: 'existing_thread', nativeThreadId: 'original-native', bindingGeneration: 3, workspaceSignature: 'a'.repeat(64) };
  let current = binding, calls = 0, cancels = 0, failNext = false;
  const host = { start: async trigger => { calls++; assert.equal(trigger.binding.nativeThreadId, 'original-native'); assert.equal(trigger.echoToWeChat, false); if (failNext) throw Error('lost receipt'); return { runtimeRunId: `fixture-${calls}` }; }, cancel: async () => { cancels++; } };
  const file = path.join(directory, 'ledger.json');
  try {
    const adapter = new AutomationAdapterSession(file, async () => current, host);
    automationAdapterCapabilitiesSchema.parse(await adapter.capabilities());
    const trigger = triggerFor(binding);
    assert.equal((await adapter.dispatch(trigger, signal())).state, 'running');
    assert.equal((await adapter.dispatch(trigger, signal())).state, 'running'); assert.equal(calls, 1);
    await assert.rejects(adapter.dispatch({ ...trigger, instructions: 'different' }, signal()), /IDEMPOTENCY_CONFLICT/);
    await assert.rejects(adapter.dispatch(triggerFor(binding), signal()), /THREAD_BUSY/); assert.equal(calls, 1);
    cases.push('durable-reserve-idempotency-conflict-original-thread-serialization');
    assert.equal((await adapter.cancel(trigger.triggerId, signal())).state, 'running'); assert.equal(cancels, 1);
    await adapter.record({ protocolVersion: 1, triggerId: trigger.triggerId, state: 'succeeded', summary: '已核验', changed: false });
    assert.equal((await adapter.status(trigger.triggerId, signal())).summary, '已核验');
    await assert.rejects(adapter.record({ protocolVersion: 1, triggerId: trigger.triggerId, state: 'running' }), /TERMINAL_CONFLICT/);
    cases.push('accepted-not-completed-cancel-not-falsely-completed-terminal-stability');
    failNext = true; const unknown = triggerFor(binding);
    await assert.rejects(adapter.dispatch(unknown, signal()), /DELIVERY_UNKNOWN/);
    const restarted = new AutomationAdapterSession(file, async () => current, host); await restarted.recover();
    assert.equal((await restarted.dispatch(unknown, signal())).state, 'uncertain'); assert.equal(calls, 2);
    cases.push('unknown-receipt-restart-no-automatic-model-retry');
    current = { ...binding, bindingGeneration: 4 };
    await assert.rejects(restarted.status(unknown.triggerId, signal()), /BINDING_REVOKED/);
    await assert.rejects(restarted.dispatch(trigger, signal()), /BINDING_REVOKED/);
    assert.equal(automationAdapterTriggerSchema.safeParse({ ...trigger, echoToWeChat: true }).success, false);
    assert.equal(automationAdapterTriggerSchema.safeParse({ ...trigger, type: 'wechat.message' }).success, false);
    assert.equal(automationAdapterTriggerSchema.safeParse({ ...trigger, binding: { ...binding, roomId: 'group', projectId: 'project' } }).success, false);
    cases.push('binding-generation-membership-and-dedicated-route-no-wechat-fallback');
    const stored = JSON.parse(await readFile(file, 'utf8')); assert.equal(JSON.stringify(stored).includes(trigger.instructions), false);
    console.log(JSON.stringify({ status: 'passed', mode: 'mock', realCyberBoss: false, modelCalled: false, cases }, null, 2));
  } finally { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('asterium-auto-adapter-')); await rm(directory, { recursive: true, force: true }); }
} else {
  assert.ok(option('--host-module') && option('--binding'), 'Build SDK, then --mock; real host: --host-module <explicit local module> --binding <binding.json>. --dispatch explicitly starts one test task.');
  const binding = JSON.parse(await readFile(option('--binding'), 'utf8'));
  const host = await import(pathToFileURL(path.resolve(option('--host-module'))));
  const adapter = await host.createAutomationAdapter(binding);
  automationAdapterCapabilitiesSchema.parse(await adapter.capabilities());
  if (!flags.includes('--dispatch')) console.log(JSON.stringify({ status: 'capabilities-only', modelCalled: false, realExecutionVerified: false }));
  else {
    const trigger = automationAdapterTriggerSchema.parse(triggerFor(binding));
    const receipt = automationAdapterReceiptSchema.parse(await adapter.dispatch(trigger, signal())); assert.equal(receipt.triggerId, trigger.triggerId);
    console.log(JSON.stringify({ status: 'dispatch-returned', triggerId: receipt.triggerId, state: receipt.state, realExecutionVerified: false,
      remaining: 'Query status and verify original host thread, existing approvals, same-conversation result and zero WeChat output. Acceptance is not completion.' }));
  }
}
});
