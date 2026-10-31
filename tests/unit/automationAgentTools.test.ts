import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AutomationStore } from '../../src/main/automation/AutomationStore';
import { AutomationService } from '../../src/main/automation/AutomationService';
import { AutomationAgentTools } from '../../src/main/automation/AutomationAgentTools';
import { automationInputSchema } from '../../src/shared/automations';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { asteriumDynamicTools } from '../../src/main/adapters/CodexCliAdapter';
import type { AsteriumRuntimeToolController } from '../../src/main/runtime/AsteriumRuntimeTools';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-auto-tool-')); dirs.push(dir);
  const store = new AutomationStore(path.join(dir, 'store.json'));
  const input = automationInputSchema.parse({ name: '整理', instructions: '整理授权目录', target: { partnerId: 'p', conversationId: 'c', sourceMode: 'local_cli', nativeThreadId: 'original', bindingGeneration: 1 }, schedule: { type: 'daily', time: '10:00' }, timezone: 'Asia/Shanghai' });
  const service = new AutomationService(store, { targets: async () => [{ target: input.target, label: '本地伙伴', available: true }], runtimeReady: () => true });
  const confirm = vi.fn(async () => true), tools = new AutomationAgentTools(service, confirm);
  const owner = { partnerId: 'p', conversationId: 'c', automatic: false };
  const create = { action: 'create', requestId: 'stable', name: input.name, instructions: input.instructions, schedule: input.schedule, timezone: input.timezone };
  return { tools, store, service, confirm, input, owner, create };
}
it('binds to the original owned target and requires visible confirmation; a timeout retry is idempotent', async () => {
  const f = await setup();
  await f.tools.call(f.create, f.owner); await f.tools.call(f.create, f.owner);
  const { automations } = await f.store.snapshot(); expect(automations).toHaveLength(1); expect(automations[0].target).toEqual(f.input.target); expect(f.confirm).toHaveBeenCalled();
  await expect(f.tools.call({ ...f.create, partnerId: 'other' }, f.owner)).rejects.toThrow();
});
it('saves create/update/pause/resume/remove directly in host-verified full permission', async () => {
  const f = await setup(), owner = { ...f.owner, permissionMode: 'full' as const };
  await f.tools.call(f.create, owner);
  const current = async () => (await f.store.snapshot()).automations[0];
  let d = await current(); expect(d.enabled).toBe(true);
  await f.tools.call({ action: 'update', id: d.id, revision: d.revision, instructions: '新的整理规则' }, owner);
  d = await current(); expect(d.instructions).toBe('新的整理规则');
  await f.tools.call({ action: 'pause', id: d.id, revision: d.revision }, owner);
  d = await current(); expect(d.enabled).toBe(false);
  await f.tools.call({ action: 'resume', id: d.id, revision: d.revision }, owner);
  d = await current(); expect(d.enabled).toBe(true);
  await f.tools.call({ action: 'remove', id: d.id, revision: d.revision }, owner);
  expect((await current()).deletedAt).toBeDefined(); expect(f.confirm).not.toHaveBeenCalled();
});
it.each(['manual', 'automatic', undefined] as const)('keeps confirmation with invoking permission %s', async permissionMode => {
  const f = await setup(); await f.tools.call(f.create, { ...f.owner, permissionMode }); expect(f.confirm).toHaveBeenCalledOnce();
});
it('does not let full permission bypass recursive/read-only/Plan restrictions, revocation or strict arguments', async () => {
  const f = await setup(), owner = { ...f.owner, permissionMode: 'full' as const };
  await expect(f.tools.call(f.create, { ...owner, automatic: true })).rejects.toThrow('RECURSIVE');
  await expect(f.tools.call(f.create, { ...owner, readOnly: true })).rejects.toThrow('READ_ONLY');
  await expect(f.tools.call(f.create, { ...owner, permissionMode: 'read_only' })).rejects.toThrow('READ_ONLY');
  await expect(f.tools.call({ ...f.create, permissionMode: 'full' }, f.owner)).rejects.toThrow();
  const revalidate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
  await expect(f.tools.call(f.create, { ...owner, revalidate })).rejects.toThrow('revoked');
  expect(f.confirm).not.toHaveBeenCalled(); expect((await f.store.snapshot()).automations).toEqual([]);
});
it('blocks automatic recursion, read-only mutation, denial and revocation during review', async () => {
  const f = await setup();
  await expect(f.tools.call(f.create, { ...f.owner, automatic: true })).rejects.toThrow('RECURSIVE');
  await expect(f.tools.call(f.create, { ...f.owner, readOnly: true })).rejects.toThrow('READ_ONLY');
  expect(f.confirm).not.toHaveBeenCalled(); f.confirm.mockResolvedValueOnce(false);
  await expect(f.tools.call(f.create, f.owner)).rejects.toThrow('USER_DECLINED');
  const revalidate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
  await expect(f.tools.call(f.create, { ...f.owner, revalidate })).rejects.toThrow('revoked');
  expect((await f.store.snapshot()).automations).toHaveLength(0);
});
it('scopes listing and updates, protects revisions, and reports changes only in an active automation', async () => {
  const f = await setup(); const own = await f.store.create(f.input, 'own');
  await f.store.create({ ...f.input, target: { ...f.input.target, partnerId: 'foreign' } }, 'foreign');
  const list = JSON.parse(await f.tools.call({ action: 'list' }, f.owner)); expect(list.automations).toHaveLength(1); expect(list.targets).toHaveLength(1);
  await expect(f.tools.call({ action: 'pause', id: own.id, revision: 999 }, f.owner)).rejects.toThrow('REVISION');
  await f.tools.call({ action: 'pause', id: own.id, revision: own.revision }, f.owner); expect((await f.service.get('p')).automations[0].enabled).toBe(false);
  const report = vi.fn(); await expect(f.tools.call({ action: 'report', changed: false }, { ...f.owner, report })).rejects.toThrow('ACTIVE_RUN');
  await f.tools.call({ action: 'report', changed: false }, { ...f.owner, automatic: true, report }); expect(report).toHaveBeenCalledWith(false);
});
it('advertises the same schema to API and Codex without adding it to restricted workflow planners', async () => {
  const controller: AsteriumRuntimeToolController = { status: async () => '{}', workspace: async () => '{}', update() {}, automation: vi.fn(async () => '{}') };
  const api = new ApiAgentTools(undefined, [], undefined, controller);
  const definition = api.definitions.find(d => d.name === 'asterium_automation'); expect(definition).toBeDefined();
  expect(asteriumDynamicTools(controller).find(d => d.name === 'asterium_automation')?.inputSchema).toEqual(definition?.parameters);
  const signal = new AbortController().signal;
  await api.prepare('asterium_automation', { action: 'list' }).execute(signal); expect(controller.automation).toHaveBeenCalledWith({ action: 'list' }, signal);
  expect(new ApiAgentTools(undefined, [], undefined, { ...controller, workflowDraft: async () => '{}' }).definitions.some(d => d.name === 'asterium_automation')).toBe(false);
});
