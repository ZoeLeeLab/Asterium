// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, rename, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiExtensionStore } from '../../src/main/api/ApiExtensionStore';
import { SkillPackageLoader } from '../../src/main/api/extensions/SkillPackageLoader';
import { ApiSkillSession } from '../../src/main/api/extensions/ApiSkillSession';
import { SkillScriptRunner } from '../../src/main/api/extensions/SkillScriptRunner';
import { NativeExtensionLaunchBackend, type ExtensionLaunchBackend } from '../../src/main/api/extensions/ExtensionLaunchBackend';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type ResolveAuthorizationCommand, type SendMessageCommand } from '../../src/shared/agentProtocol';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';
import type { AsteriumRuntimeToolController } from '../../src/main/adapters/PartnerAdapter';

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) { const resolved = await realpath(dir); expect(path.dirname(resolved).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase()); expect(path.basename(resolved)).toMatch(/^asterium-script-unit-/); await rm(resolved, { recursive: true, force: true, maxRetries: 5 }); } });
const policy = { permissionMode: 'manual', planMode: 'default' } as const;
const code = 'console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),private:process.env.ASTERIUM_PRIVATE_CANARY}));';
async function setup(trust: 'pending' | 'untrusted' = 'pending', script = code, backend: ExtensionLaunchBackend = new NativeExtensionLaunchBackend(), timeout = 3000) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-script-unit-')); roots.push(dir);
  const folder = path.join(dir, 'skill'), cwd = path.join(dir, 'workspace'); await mkdir(path.join(folder, 'scripts'), { recursive: true }); await mkdir(cwd);
  await writeFile(path.join(folder, 'SKILL.md'), '---\nname: fixture\ndescription: script fixture\n---\nRun scripts/main.mjs');
  const filename = path.join(folder, 'scripts/main.mjs'); await writeFile(filename, script);
  const store = new ApiExtensionStore(path.join(dir, 'extensions.json'), { save: async () => '', get: async () => undefined, delete: async () => undefined }, () => true);
  let state = await store.upsert({ expectedVersion: 0, name: 'Fixture', enabled: true, configuration: { type: 'skill', directory: folder } }); const id = state.extensions[0].id;
  state = await store.setBinding({ expectedVersion: state.version, partnerId: 'api', extensionIds: [id] });
  if (trust === 'pending') await store.setTrust({ expectedVersion: state.version, id, action: 'request' });
  const loader = new SkillPackageLoader(store, [path.join(dir, 'protected')]), runner = new SkillScriptRunner(backend, timeout);
  let workspaceVersion = 1;
  const runtimeTools: AsteriumRuntimeToolController = { status: async () => JSON.stringify({ cwd, workspaceFolders: [cwd], workspaceVersion }), workspace: async () => '', update: () => undefined };
  const base: SendMessageCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'c', partnerId: 'api', conversationId: 'conv', clientMessageId: 'm', connectionSource: 'api_partner', content: { type: 'text', text: 'run skill' }, execution: policy };
  const make = (overrides: Partial<SendMessageCommand> = {}, repeats = 1, args: Record<string, unknown> = { script: 'scripts/main.mjs', args: ['hello'] }, forcedName?: string) => {
    const command = { ...base, ...overrides }, tools = new ApiAgentTools(cwd, [], undefined, runtimeTools, undefined, [path.join(dir, 'protected')]);
    const session = new ApiSkillSession(store, loader, command, { runner, runtimeTools, tools, cwd }); let round = 0; const requests: ApiProviderRequest[] = [];
    const provider: ApiProviderAdapter = { provider: 'scripted', capabilities: { streamingText: true, reasoning: false, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } }, async *stream(request) {
      requests.push(request); const name = forcedName ?? request.tools.find((tool) => tool.name.startsWith('skill_run_'))?.name;
      if (round++ < repeats && name) { yield { type: 'tool.delta', index: 0, id: `call-${round}`, name, arguments: JSON.stringify(args) }; yield { type: 'finish', reason: 'tool_calls' }; }
      else { yield { type: 'text.delta', text: 'done' }; yield { type: 'finish', reason: 'stop' }; }
    } };
    return { command, tools, session, runtime: new ApiAgentRuntime({ provider, tools, skillSession: session }), requests };
  };
  return { dir, folder, filename, cwd, id, store, loader, runner, make, changeWorkspace: () => workspaceVersion++ };
}
type Run = ReturnType<Awaited<ReturnType<typeof setup>>['make']>;
type Requested = Extract<PartnerEvent, { type: 'authorization.requested' }>;
async function collect(run: Run, approve: (event: Requested) => Promise<Partial<ResolveAuthorizationCommand> | void> = async () => ({})) {
  const events: PartnerEvent[] = [];
  for await (const event of run.runtime.sendMessage(run.command)) {
    events.push(event);
    if (event.type === 'authorization.requested') await run.runtime.resolveAuthorization({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'authorization.resolve', commandId: 'answer', partnerId: event.partnerId, conversationId: event.conversationId, clientMessageId: event.clientMessageId, sessionId: event.sessionId, connectionSource: event.connectionSource, runId: event.runId, authorizationId: event.authorizationId, decision: 'allow_once', ...await approve(event) });
    if (event.type === 'user_input.requested') await run.runtime.resolveUserInput({ ...run.command, type: 'user_input.resolve', runId: event.runId, sessionId: event.sessionId, requestId: event.requestId, answers: { 'plan-execution': ['暂不执行'] } });
  }
  return events;
}
const requests = (events: PartnerEvent[]) => events.filter((event) => event.type === 'authorization.requested');
const successes = (events: PartnerEvent[]) => events.filter((event) => event.type === 'tool.completed' && event.outcome === 'success');
describe('API packaged skill execution and approval', () => {
  it('shows the fixed partner workspace without claiming a backend before execution', async () => {
    const backend = new NativeExtensionLaunchBackend(), launch = vi.spyOn(backend, 'launchSkillScript');
    const s = await setup('untrusted', code, backend);
    const events = await collect(s.make({}, 1, { script: 'scripts/main.mjs', args: [] }), async event => {
      expect(event.summary).toContain('以实际启动结果为准');
      expect(event.summary).not.toMatch(/当前为|原生、未沙箱隔离/);
      expect(event.targets).toContain(`工作目录：${s.cwd}`);
      expect(launch).not.toHaveBeenCalled();
      return { decision: 'deny' };
    });
    expect(requests(events)).toHaveLength(1); expect(launch).not.toHaveBeenCalled();
    const run = s.make(); const registration = (await run.session.registrations(policy)).find(r => r.presentationName === 'skill_run')!;
    expect(registration.definition.parameters).toMatchObject({ additionalProperties: false, properties: { script: expect.any(Object), args: expect.any(Object) } });
    expect(registration.definition.parameters.properties).not.toHaveProperty('cwd');
  });
  it('passes Main-owned identity, workspace and approved package authority through the common entry', async () => {
    const backend = new NativeExtensionLaunchBackend(), launch = vi.spyOn(backend, 'launchSkillScript');
    const s = await setup('untrusted', code, backend);
    const events = await collect(s.make());
    expect(successes(events)).toHaveLength(1);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0].context).toMatchObject({
      kind: 'partner_runtime', partnerId: 'api', conversationId: 'conv',
      policy: { permissionMode: 'manual', planMode: 'default' },
      workspace: { cwd: s.cwd, workspaceFolders: [s.cwd], workspaceVersion: 1 },
      extension: { id: s.id, generation: expect.any(Number), bindingRevision: expect.any(Number), packageDigest: expect.any(String) },
    });
  });
  it.each([false, true])('expires the old approval after unbind/rebind (persist=%s), while a fresh call works', async (persist) => {
    const backend = new NativeExtensionLaunchBackend(), launch = vi.spyOn(backend, 'launchSkillScript'), s = await setup('pending', code, backend);
    const events = await collect(s.make(), async () => {
      const before = await s.store.get();
      const unbound = await s.store.setBinding({ expectedVersion: before.version, partnerId: 'api', extensionIds: [] });
      await s.store.setBinding({ expectedVersion: unbound.version, partnerId: 'api', extensionIds: [s.id] });
      return { persistExtensionTrust: persist };
    });
    expect(successes(events)).toHaveLength(0); expect(launch).not.toHaveBeenCalled(); expect((await s.store.get()).extensions[0].trust).toBe('pending');
    const fresh = await collect(s.make(), async () => ({ persistExtensionTrust: true }));
    expect(requests(fresh)).toHaveLength(1); expect(successes(fresh)).toHaveLength(1);
  });
  it('refuses recursive cleanup if a native script replaces its snapshot with a junction', async () => {
    const backend = new NativeExtensionLaunchBackend(), original = backend.launchSkillScript.bind(backend), s = await setup('untrusted', code, backend);
    const canary = path.join(s.cwd, 'canary'); await writeFile(canary, 'KEEP'); let staging = '';
    vi.spyOn(backend, 'launchSkillScript').mockImplementation(async (request) => {
      staging = path.dirname(path.dirname(request.args[0])); const launched = await original(request);
      return { process: launched.process, close: async () => {
        await launched.close(); const resolved = await realpath(staging);
        expect(path.dirname(resolved).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase()); expect(path.basename(resolved)).toMatch(/^asterium-skill-run-/);
        await rename(staging, `${staging}-moved`); await symlink(s.cwd, staging, 'junction');
      } };
    });
    try {
      await expect(s.runner.run(await s.loader.read(s.folder), 'scripts/main.mjs', [], s.cwd, new AbortController().signal, (start) => start())).rejects.toThrow('SKILL_CLEANUP_PATH_INVALID');
      expect(await readFile(canary, 'utf8')).toBe('KEEP');
    } finally {
      if (staging) {
        await unlink(staging);
        const moved = await realpath(`${staging}-moved`); expect(path.dirname(moved).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase()); expect(path.basename(moved)).toMatch(/^asterium-skill-run-.*-moved$/);
        await rm(moved, { recursive: true, force: true });
      }
    }
  });
  it('runs the documented example and never overwrites an existing report', async () => {
    const s = await setup(); await writeFile(path.join(s.cwd, 'input.txt'), 'synthetic');
    const loaded = await s.loader.read(path.resolve('examples/api-skills/workspace-report'));
    const result = await s.runner.run(loaded, 'scripts/report.mjs', ['example.md'], s.cwd, new AbortController().signal, (start) => start());
    expect(result.isError).toBe(false); const report = await readFile(path.join(s.cwd, 'example.md'), 'utf8'); expect(report).toContain('input.txt');
    const again = await s.runner.run(loaded, 'scripts/report.mjs', ['example.md'], s.cwd, new AbortController().signal, (start) => start());
    expect(again.isError).toBe(true); expect(await readFile(path.join(s.cwd, 'example.md'), 'utf8')).toBe(report);
  });
  it('preserves UTF-8 output when a character spans separate process chunks', async () => {
    const s = await setup('untrusted', 'process.stdout.write(Buffer.from([0xe6]));setTimeout(()=>process.stdout.write(Buffer.from([0x98,0x9f])),60);');
    const r = s.make(); await collect(r);
    const response = r.requests[1].messages.find((message) => message.role === 'tool')!;
    expect(JSON.parse(JSON.parse(response.content as string).result).output).toBe('星');
  });
  it('requires each untrusted call and keeps literal argv, cwd and minimal environment', async () => {
    const s = await setup('untrusted'); const previous = process.env.ASTERIUM_PRIVATE_CANARY; process.env.ASTERIUM_PRIVATE_CANARY = 'private';
    try {
      const r = s.make({}, 2, { script: 'scripts/main.mjs', args: ['a b', ';Write-Host injected', '$(secret)', '--eval'] }); const events = await collect(r);
      expect(requests(events)).toHaveLength(2); expect(requests(events)[0].extensionTrust).toBeUndefined(); expect(successes(events)).toHaveLength(2);
      const response = r.requests[1].messages.find((message) => message.role === 'tool')!;
      const value = JSON.parse(JSON.parse(JSON.parse(response.content as string).result).output);
      expect(value.argv).toEqual(['a b', ';Write-Host injected', '$(secret)', '--eval']); expect(value.cwd).toBe(s.cwd); expect(value.private).toBeUndefined();
    } finally { if (previous === undefined) delete process.env.ASTERIUM_PRIVATE_CANARY; else process.env.ASTERIUM_PRIVATE_CANARY = previous; }
  });
  it('allow-once keeps pending, explicit persist skips subsequent prompts across runs, revoke restores approval', async () => {
    const s = await setup(); expect(requests(await collect(s.make()))).toHaveLength(1); expect((await s.store.get()).extensions[0].trust).toBe('pending');
    const events = await collect(s.make({}, 2), async (event) => { expect(event.extensionTrust?.kind).toBe('skill'); return { persistExtensionTrust: true }; });
    expect(requests(events)).toHaveLength(1); expect(successes(events)).toHaveLength(2);
    expect(requests(await collect(s.make({ conversationId: 'another' })))).toHaveLength(0);
    await s.store.setTrust({ expectedVersion: (await s.store.get()).version, id: s.id, action: 'revoke' });
    expect(requests(await collect(s.make()))).toHaveLength(1);
  });
  it.each(['read_only', 'plan'] as const)('established trust never exposes scripts in %s', async (mode) => {
    const s = await setup(); await collect(s.make(), async () => ({ persistExtensionTrust: true }));
    const r = s.make({ execution: { permissionMode: mode === 'read_only' ? 'read_only' : 'full', planMode: mode === 'plan' ? 'plan' : 'default' } }); const events = await collect(r);
    expect(r.requests[0].tools.some((tool) => tool.name.startsWith('skill_run_'))).toBe(false); expect(successes(events)).toHaveLength(0); expect(requests(events)).toHaveLength(0);
  });
  it('full mode executes without activating pending trust; automatic still asks', async () => {
    const s = await setup(); const events = await collect(s.make({ execution: { permissionMode: 'full', planMode: 'default' } }));
    expect(successes(events)).toHaveLength(1); expect(requests(events)).toHaveLength(0); expect((await s.store.get()).extensions[0].trust).toBe('pending');
    expect(requests(await collect(s.make({ execution: { permissionMode: 'automatic', planMode: 'default' } })))).toHaveLength(1);
  });
  it.each(['package', 'binding', 'revoke', 'context'] as const)('rejects a waiting approval after %s changes without launching', async (change) => {
    const backend = new NativeExtensionLaunchBackend(), launch = vi.spyOn(backend, 'launchSkillScript'), s = await setup('pending', code, backend);
    const events = await collect(s.make(), async () => {
      const state = await s.store.get();
      if (change === 'package') await writeFile(s.filename, 'console.log("replacement")');
      if (change === 'binding') await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api', extensionIds: [] });
      if (change === 'revoke') await s.store.setTrust({ expectedVersion: state.version, id: s.id, action: 'revoke' });
      if (change === 'context') s.changeWorkspace();
      return { persistExtensionTrust: true };
    });
    expect(successes(events)).toHaveLength(0); expect(launch).not.toHaveBeenCalled(); expect((await s.store.get()).extensions[0].trust).not.toBe('trusted');
  });
  it('a changed package invalidates established trust before the next call', async () => {
    const s = await setup(); await collect(s.make(), async () => ({ persistExtensionTrust: true })); await writeFile(s.filename, code + '\n// new version');
    expect(requests(await collect(s.make()))).toHaveLength(1); expect((await s.store.get()).extensions[0].trust).toBe('pending');
  });
  it('trust cannot authorize generic run_command, arbitrary scripts or outside workspace arguments', async () => {
    const s = await setup(); await collect(s.make(), async () => ({ persistExtensionTrust: true }));
    const generic = await collect(s.make({}, 1, { command: 'Write-Output synthetic' }, 'run_command'), async () => ({ decision: 'deny' })); expect(requests(generic)).toHaveLength(1);
    for (const args of [{ script: '../outside.mjs' }, { script: 'scripts/main.mjs', args: [s.filename] }, { script: 'scripts/main.mjs', args: ['../outside'] }]) expect(successes(await collect(s.make({}, 1, args)))).toHaveLength(0);
  });
  it('runs the immutable approved snapshot even if the source changes at launch', async () => {
    const backend = new NativeExtensionLaunchBackend(), launch = backend.launchSkillScript.bind(backend), s = await setup('pending', 'console.log("APPROVED_BYTES")', backend);
    vi.spyOn(backend, 'launchSkillScript').mockImplementation(async (request) => { await writeFile(s.filename, 'console.log("CHANGED_BYTES")'); return launch(request); });
    const events = await collect(s.make()); expect(successes(events)).toHaveLength(1); expect(JSON.stringify(successes(events))).toContain('APPROVED_BYTES'); expect(JSON.stringify(successes(events))).not.toContain('CHANGED_BYTES');
  });
  it.each(['timeout', 'output'] as const)('bounds %s and removes the snapshot after killing a live script', async (mode) => {
    const backend = new NativeExtensionLaunchBackend(), launch = vi.spyOn(backend, 'launchSkillScript'), s = await setup('pending', mode === 'timeout' ? 'setInterval(()=>{},1000)' : 'setInterval(()=>process.stdout.write("x".repeat(65536)),1)', backend, mode === 'timeout' ? 500 : 3000);
    const events = await collect(s.make()); expect(successes(events)).toHaveLength(0); expect(JSON.stringify(events)).toContain(mode === 'timeout' ? 'SKILL_SCRIPT_TIMEOUT' : 'SKILL_SCRIPT_OUTPUT_LIMIT');
    const launched = await launch.mock.results[0].value; expect(launched.process.exitCode !== null || launched.process.signalCode !== null).toBe(true);
    await expect(readFile(launch.mock.calls[0][0].args[0])).rejects.toThrow();
  });
  it('uses the selected sandbox backend without falling back to native when it fails', async () => {
    const sandbox: ExtensionLaunchBackend = { id: 'sandbox', sandboxed: true, createMcpTransport: () => { throw new Error(); }, launchSkillScript: vi.fn(async () => { throw new Error('SANDBOX_UNAVAILABLE'); }) };
    const s = await setup('pending', code, sandbox); expect(successes(await collect(s.make()))).toHaveLength(0); expect(sandbox.launchSkillScript).toHaveBeenCalledOnce();
  });
  it('cancels a pending persistent approval without starting or establishing trust', async () => {
    const backend = new NativeExtensionLaunchBackend(), launch = vi.spyOn(backend, 'launchSkillScript'), s = await setup('pending', code, backend), r = s.make();
    const events: PartnerEvent[] = [];
    for await (const event of r.runtime.sendMessage(r.command)) {
      events.push(event);
      if (event.type === 'authorization.requested') await r.runtime.cancel({ ...r.command, type: 'run.cancel', runId: event.runId, sessionId: event.sessionId, reason: 'user' });
    }
    expect(launch).not.toHaveBeenCalled(); expect((await s.store.get()).extensions[0].trust).toBe('pending'); expect(events.some((event) => event.type === 'run.cancelled')).toBe(true);
  });
  it('cancels a running script and removes its staged bytes', async () => {
    const backend = new NativeExtensionLaunchBackend(), launch = vi.spyOn(backend, 'launchSkillScript'), s = await setup('pending', 'setInterval(()=>{},1000)', backend);
    const loaded = await s.loader.read(s.folder), controller = new AbortController();
    const pending = s.runner.run(loaded, 'scripts/main.mjs', [], s.cwd, controller.signal, (start) => start());
    const rejected = expect(pending).rejects.toThrow('SKILL_SCRIPT_CANCELLED');
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce()); await launch.mock.results[0].value;
    controller.abort(); await rejected;
    const launched = await launch.mock.results[0].value; expect(launched.process.exitCode !== null || launched.process.signalCode !== null).toBe(true);
    await expect(readFile(launch.mock.calls[0][0].args[0])).rejects.toThrow();
  });
  it('treats a nonzero exit as failure and retains bounded passive output', async () => {
    const s = await setup('pending', 'console.error("SCRIPT_FAILURE");process.exitCode=3;');
    const events = await collect(s.make()); expect(successes(events)).toHaveLength(0); expect(JSON.stringify(events)).toContain('SCRIPT_FAILURE');
  });
  it('rejects missing Python before launching or opening a Windows Store alias', async () => {
    const backend = new NativeExtensionLaunchBackend(), launch = vi.spyOn(backend, 'launchSkillScript'), s = await setup('pending', code, backend);
    await writeFile(path.join(s.folder, 'scripts/python.py'), 'print("fixture")'); const loaded = await s.loader.read(s.folder);
    const original = process.env.PATH;
    try {
      process.env.PATH = '';
      await expect(s.runner.run(loaded, 'scripts/python.py', [], s.cwd, new AbortController().signal, (start) => start())).rejects.toThrow('SKILL_PYTHON_UNAVAILABLE');
      expect(launch).not.toHaveBeenCalled();
    } finally { process.env.PATH = original; }
  });
  it.runIf(process.platform === 'win32')('executes PowerShell with literal script arguments and the existing execution policy', async () => {
    const s = await setup(); await writeFile(path.join(s.folder, 'scripts/powershell.ps1'), 'param([string]$Value)\n[Console]::WriteLine("PS-SAFE:$Value")\n');
    const result = await s.runner.run(await s.loader.read(s.folder), 'scripts/powershell.ps1', ['hello;$(Write-Output injected)'], s.cwd, new AbortController().signal, (start) => start());
    const response = JSON.parse(result.content);
    // Restricted enterprise execution policy can reject unsigned scripts; never bypass that policy.
    if (result.isError) expect(response.exitCode).not.toBe(0);
    else expect(response.output).toContain('PS-SAFE:hello;$(Write-Output injected)');
  });
});
