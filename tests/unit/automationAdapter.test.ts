// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AutomationAdapterSession } from '../../src/main/automation/automationAdapterSdk';
import type { AutomationAdapterTrigger } from '../../src/shared/automationAdapter';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const trigger: AutomationAdapterTrigger = { protocolVersion: 1, type: 'asterium.automation', source: 'asterium', triggerId: 'run', occurrenceId: 'occurrence', automationId: 'automation', scheduledAt: '2026-10-25T02:00:00Z', name: '巡检', instructions: '检查已授权目录',
  binding: { adapterId: 'a', partnerId: 'chuan', conversationId: 'c', sourceMode: 'existing_thread', nativeThreadId: 'original', bindingGeneration: 1, workspaceSignature: 'a'.repeat(64) }, delivery: 'original_conversation_only', allowNewThread: false, echoToWeChat: false };
async function file() { const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-adapter-unit-')); dirs.push(dir); return path.join(dir, 'state.json'); }
it('reserves concurrent duplicate dispatch once and never regresses synchronous host completion', async () => {
  const start = vi.fn(async () => { await adapter.record({ protocolVersion: 1, triggerId: trigger.triggerId, state: 'succeeded', summary: '完成' }); return { runtimeRunId: 'host-run' }; });
  const adapter = new AutomationAdapterSession(await file(), async () => trigger.binding, { start, cancel: async () => undefined });
  await Promise.all([adapter.dispatch(trigger, new AbortController().signal), adapter.dispatch(trigger, new AbortController().signal)]);
  expect(start).toHaveBeenCalledOnce(); expect((await adapter.status(trigger.triggerId, new AbortController().signal))?.state).toBe('succeeded');
});
it('fails closed on corrupt durable reservations instead of restarting a task', async () => {
  const location = await file(); await writeFile(location, '{broken'); const start = vi.fn();
  const adapter = new AutomationAdapterSession(location, async () => trigger.binding, { start, cancel: async () => undefined });
  await expect(adapter.recover()).rejects.toThrow(); await expect(adapter.dispatch(trigger, new AbortController().signal)).rejects.toThrow(); expect(start).not.toHaveBeenCalled();
});
