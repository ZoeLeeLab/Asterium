// @vitest-environment node
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiExtensionStore } from '../../src/main/api/ApiExtensionStore';
import { SkillPackageLoader } from '../../src/main/api/extensions/SkillPackageLoader';
import { ApiSkillSession } from '../../src/main/api/extensions/ApiSkillSession';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import { AGENT_PROTOCOL_VERSION, type SendMessageCommand } from '../../src/shared/agentProtocol';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) { const real = await realpath(dir); expect(path.dirname(real).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase()); expect(path.basename(real)).toMatch(/^asterium-skills-unit-/); await rm(real, { recursive: true, force: true }); } });
const document = '---\nname: fixture\ndescription: |\n  Synthetic test skill\n---\nRead references/help.txt when needed.\n';
const policy = { permissionMode: 'manual', planMode: 'default' } as const;
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-skills-unit-')); roots.push(dir);
  const folder = path.join(dir, 'package'); await mkdir(path.join(folder, 'references'), { recursive: true });
  await writeFile(path.join(folder, 'SKILL.md'), document); await writeFile(path.join(folder, 'references/help.txt'), 'reference-content');
  const store = new ApiExtensionStore(path.join(dir, 'extensions.json'), { save: async () => '', get: async () => undefined, delete: async () => undefined }, async (id) => id === 'api');
  const snapshot = await store.upsert({ expectedVersion: 0, name: 'Fixture', enabled: true, configuration: { type: 'skill', directory: folder } });
  const id = snapshot.extensions[0].id;
  await store.setBinding({ expectedVersion: snapshot.version, partnerId: 'api', extensionIds: [id] });
  const loader = new SkillPackageLoader(store, [path.join(dir, 'protected')]);
  const command: SendMessageCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'c', partnerId: 'api', conversationId: 'conv', clientMessageId: 'm', connectionSource: 'api_partner', content: { type: 'text', text: 'read skill' }, execution: policy };
  const session = new ApiSkillSession(store, loader, command);
  const entry = async () => (await store.get()).extensions[0];
  return { dir, folder, store, loader, command, session, entry, id };
}
describe('API skill package loader and read tools', () => {
  it('invalidates a broken trusted package once, leaves other drafts current, and rediscovers recovery', async () => {
    const s = await setup(); await s.loader.inspect(await s.entry());
    await s.store.setTrust({ expectedVersion: (await s.store.get()).version, id: s.id, action: 'request' });
    const token = await s.store.prepareTrustApproval(s.id, policy, 'api'); await s.store.confirmTrustApproval(token, policy, 'api');
    await writeFile(path.join(s.folder, 'SKILL.md'), 'broken metadata');
    await expect(s.loader.inspect(await s.entry())).rejects.toThrow();
    const invalid = await s.store.get(); expect(invalid.extensions[0].trust).toBe('pending'); expect(invalid.extensions[0].inventoryKnown).toBe(false);
    for (let i = 0; i < 3; i++) { await expect(s.loader.inspect(await s.entry())).rejects.toThrow(); expect(await s.store.get()).toEqual(invalid); }
    // A draft based on the first invalidation remains saveable despite repeated failed reads.
    await s.store.upsert({ expectedVersion: invalid.version, id: s.id, name: 'Renamed while invalid', enabled: true, configuration: invalid.extensions[0].configuration });
    await writeFile(path.join(s.folder, 'SKILL.md'), document); await s.loader.inspect(await s.entry());
    expect((await s.entry()).inventoryKnown).toBe(true); expect((await s.entry()).trust).toBe('pending');
  });
  it('progressively discloses only bound package instructions and exact text resources', async () => {
    const s = await setup(), tools = new ApiAgentTools(undefined);
    tools.setExtensions(await s.session.registrations(policy));
    expect(tools.definitions).toContainEqual(expect.objectContaining({ description: expect.stringContaining('Synthetic test skill') }));
    expect(JSON.stringify(tools.definitions)).not.toContain('Read references/help');
    const name = tools.definitions.find((tool) => tool.name.startsWith('skill_read_'))!.name;
    expect((await tools.prepare(name, {}).execute(new AbortController().signal)).content).toContain('Read references/help');
    expect((await tools.prepare(name, { resource: 'references/help.txt' }).execute(new AbortController().signal)).content).toContain('reference-content');
    for (const resource of ['../outside', 'references/../SKILL.md', 'K:\\secret', 'file:///etc/passwd']) await expect(tools.prepare(name, { resource }).execute(new AbortController().signal)).rejects.toThrow('SKILL_RESOURCE_UNAVAILABLE');
  });
  it('refreshes fingerprints on any package content change and expires prepared reads', async () => {
    const s = await setup(); let snapshot = await s.store.get(); await s.store.setTrust({ expectedVersion: snapshot.version, id: s.id, action: 'request' });
    const tools = new ApiAgentTools(undefined); tools.setExtensions(await s.session.registrations(policy));
    const prepared = tools.prepare(tools.definitions.find((tool) => tool.name.startsWith('skill_read_'))!.name, {});
    const token = await s.store.prepareTrustApproval(s.id, policy); await s.store.confirmTrustApproval(token, policy, 'api');
    await writeFile(path.join(s.folder, 'references/help.txt'), 'changed');
    await expect(prepared.guard!(policy)).rejects.toThrow('SKILL_PACKAGE_CHANGED');
    expect((await s.entry()).trust).toBe('pending');
    snapshot = await s.store.get(); await s.store.setBinding({ expectedVersion: snapshot.version, partnerId: 'api', extensionIds: [] });
    expect(await s.session.registrations(policy)).toEqual([]);
  });
  it.each(['---\nname: a\nname: b\ndescription: duplicate\n---\ntext', '---\nname: a\ndescription: &x [*x]\n---\ntext', '---\nname: a\ndescription: !!js/function x\n---\ntext', 'no header', '---\nname: 1\ndescription: test\n---\ntext'])('rejects unsupported or ambiguous metadata without excerpts', async (text) => {
    const s = await setup(); await writeFile(path.join(s.folder, 'SKILL.md'), text);
    expect(await s.session.registrations(policy)).toEqual([]); expect(s.session.takeNotices()[0]).not.toContain(text);
  });
  it('rejects junctions, protected package roots and oversized package files', async () => {
    const s = await setup(), outside = path.join(s.dir, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(s.folder, 'escape'), 'junction');
    await expect(s.loader.read(s.folder)).rejects.toThrow('SKILL_PACKAGE_LINK');
    await expect(new SkillPackageLoader(s.store, [s.folder]).read(s.folder)).rejects.toThrow('SKILL_PACKAGE_UNAVAILABLE');
    await rm(path.join(s.folder, 'escape'));
    await writeFile(path.join(s.folder, 'huge'), Buffer.alloc(1024 * 1024 + 1));
    await expect(s.loader.read(s.folder)).rejects.toThrow('SKILL_PACKAGE_LIMIT');
  });
  it('does not expose hidden files or ignored dependencies and refuses binary text decoding', async () => {
    const s = await setup(); await writeFile(path.join(s.folder, '.env'), 'hidden-secret'); await writeFile(path.join(s.folder, 'binary'), Buffer.from([0, 255]));
    const tools = new ApiAgentTools(undefined); tools.setExtensions(await s.session.registrations(policy));
    const name = tools.definitions.find((tool) => tool.name.startsWith('skill_read_'))!.name;
    await expect(tools.prepare(name, { resource: '.env' }).execute(new AbortController().signal)).rejects.toThrow('SKILL_RESOURCE_UNAVAILABLE');
    await expect(tools.prepare(name, { resource: 'binary' }).execute(new AbortController().signal)).rejects.toThrow('SKILL_RESOURCE_NOT_TEXT');
  });
  it.each(['manual', 'read_only', 'plan'] as const)('runs actual read-tool rounds in %s without approval or trust activation', async (mode) => {
    const s = await setup(); s.command.execution = { permissionMode: mode === 'read_only' ? 'read_only' : 'manual', planMode: mode === 'plan' ? 'plan' : 'default' };
    let round = 0; const requests: ApiProviderRequest[] = [];
    const provider: ApiProviderAdapter = { provider: 'scripted', capabilities: { streamingText: true, reasoning: false, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } }, async *stream(request) {
      requests.push(request); if (!round++) { yield { type: 'tool.delta', index: 0, id: 'read', name: request.tools.find((tool) => tool.name.startsWith('skill_read_'))!.name, arguments: '{}' }; yield { type: 'finish', reason: 'tool_calls' }; }
      else { yield { type: 'text.delta', text: 'done' }; yield { type: 'finish', reason: 'stop' }; }
    } };
    const runtime = new ApiAgentRuntime({ provider, tools: new ApiAgentTools(undefined), skillSession: s.session }); const events = [];
    for await (const event of runtime.sendMessage(s.command)) { events.push(event); if (event.type === 'user_input.requested') await runtime.resolveUserInput({ ...s.command, type: 'user_input.resolve', runId: event.runId, sessionId: event.sessionId, requestId: event.requestId, answers: { 'plan-execution': ['暂不执行'] } }); }
    expect(events.some((event) => event.type === 'authorization.requested')).toBe(false);
    expect(events.find(event => event.type === 'tool.started')).toMatchObject({ toolName: expect.stringMatching(/^skill_read_/), presentationName: 'skill_read' });
    expect(JSON.stringify(requests[1].messages)).toContain('Read references/help'); expect((await s.entry()).trust).toBe('untrusted');
  });
  it('excludes workflow planning, disabled and ineligible partners', async () => {
    const s = await setup();
    const restricted = new ApiSkillSession(s.store, s.loader, { ...s.command, route: { scope: 'workflow_planning', projectId: 'p', roomId: 'r', generationId: 'g', bindingGeneration: 1 } });
    expect(await restricted.registrations(policy)).toEqual([]);
    const entry = await s.entry(); await s.store.upsert({ expectedVersion: (await s.store.get()).version, id: entry.id, name: entry.name, configuration: entry.configuration, enabled: false });
    expect(await s.session.registrations(policy)).toEqual([]);
  });
});
