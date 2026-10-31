// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiConnectionStore } from '../../src/main/api/ApiConnectionStore';
import { ApiAgentSessionStore, bindApiSession, type ApiAgentSession } from '../../src/main/api/ApiAgentSessionStore';
import type { ApiPartnerConnection } from '../../src/shared/agentProtocol';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('UNSAFE_TEST_CLEANUP');
    await rm(directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-api-config-')); directories.push(directory);
  const file = path.join(directory, 'connections.json');
  return { directory, file, store: new ApiConnectionStore(file) };
}
const legacy: ApiPartnerConnection = { provider: 'deepseek', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat', credentialRef: 'secret-reference', thinkingMode: 'enabled', reasoningEffort: 'high' };
describe('authoritative API connections', () => {
  it('enables new generic models by default while preserving explicit disabled choices across restart', async () => {
    const { store, file } = await setup();
    await store.migrateLegacy('new', { ...legacy, provider: 'openai' });
    const config = await store.snapshot(); expect(config.models[0].tools).toBe(true);
    await store.mutate({ action: 'model', expectedRevision: config.revision, value: { ...config.models[0], tools: false } });
    expect((await new ApiConnectionStore(file).snapshot()).models[0].tools).toBe(false);
    await store.migrateLegacy('explicit-off', { ...legacy, provider: 'openai', toolsEnabled: false });
    expect((await store.resolve('explicit-off', legacy)).toolsEnabled).toBe(false);
  });
  it('supplies the required output limit when an existing custom site switches to Messages', async () => {
    const { store } = await setup(); await store.migrateLegacy('a', { ...legacy, provider: 'openai' });
    let data = await store.snapshot();
    data = await store.mutate({ action: 'service', expectedRevision: data.revision, value: { ...data.services[0], protocol: 'anthropic_messages' } });
    expect(data.models[0].settings?.maxOutputTokens).toBe(4096);
    expect(data.models[0].tools).toBe(true); expect(data.bindings[0].partnerId).toBe('a');
    expect((await store.resolve('a', legacy)).provider).toBe('anthropic');
  });
  it('deletes an unused site and its model profiles atomically while preserving other sites', async () => {
    const { store } = await setup(); await store.migrateLegacy('a', legacy); await store.migrateLegacy('b', legacy);
    let data = await store.snapshot(); const service = data.services[0];
    await expect(store.mutate({ action: 'delete_service', expectedRevision: data.revision, id: service.id })).rejects.toThrow('API_SERVICE_IN_USE');
    data = await store.mutate({ action: 'bind', expectedRevision: data.revision, partnerId: 'a', modelId: null });
    data = await store.mutate({ action: 'delete_service', expectedRevision: data.revision, id: service.id });
    expect(data.services).toHaveLength(1); expect(data.models).toHaveLength(1); expect(data.bindings).toHaveLength(1);
    expect(data.models[0].serviceId).toBe(data.services[0].id);
  });
  it('migrates each legacy partner independently and is restart-idempotent without storing secrets', async () => {
    const { file, store } = await setup();
    await store.migrateLegacy('a', legacy); await store.migrateLegacy('b', legacy);
    const before = await store.snapshot();
    expect(before.services).toHaveLength(2);
    const restarted = new ApiConnectionStore(file); await restarted.migrateLegacy('a', legacy);
    expect(await restarted.snapshot()).toEqual(before);
    expect(await restarted.resolve('a', legacy)).toMatchObject({ ...legacy, toolsEnabled: true });
    expect(await readFile(file, 'utf8')).not.toContain('apiKey');
  });
  it('shares models, protects references, snapshots running configuration and rejects stale edits', async () => {
    const { store } = await setup(); await store.migrateLegacy('a', legacy);
    let data = await store.snapshot(); const model = data.models[0];
    data = await store.mutate({ action: 'bind', expectedRevision: data.revision, partnerId: 'b', modelId: model.id });
    const old = await store.resolve('b', legacy);
    await expect(store.mutate({ action: 'delete_model', expectedRevision: data.revision, id: model.id })).rejects.toThrow('API_MODEL_IN_USE');
    await expect(store.mutate({ action: 'delete_service', expectedRevision: data.revision, id: model.serviceId })).rejects.toThrow('API_SERVICE_IN_USE');
    await expect(store.assertCredentialUnreferenced(legacy.credentialRef)).rejects.toThrow('API_CREDENTIAL_IN_USE');
    data = await store.mutate({ action: 'model', expectedRevision: data.revision, value: { ...model, model: 'new-model' } });
    expect(old.model).toBe('deepseek-chat'); expect((await store.resolve('b', legacy)).model).toBe('new-model');
    await expect(store.mutate({ action: 'bind', expectedRevision: 0, partnerId: 'c', modelId: model.id })).rejects.toThrow('API_CONFIGURATION_CHANGED');
    data = await store.mutate({ action: 'bind', expectedRevision: data.revision, partnerId: 'a', modelId: null });
    await expect(store.assertCredentialUnreferenced(legacy.credentialRef)).rejects.toThrow('API_CREDENTIAL_IN_USE');
    data = await store.mutate({ action: 'bind', expectedRevision: data.revision, partnerId: 'b', modelId: null });
    data = await store.mutate({ action: 'delete_model', expectedRevision: data.revision, id: model.id });
    await store.mutate({ action: 'delete_service', expectedRevision: data.revision, id: model.serviceId });
    await store.assertCredentialUnreferenced(legacy.credentialRef);
  });
  it('preserves legacy data on migration failure and never overwrites explicit bindings', async () => {
    const { file, store } = await setup();
    const before = structuredClone(legacy);
    await expect(store.migrateLegacy('a', { ...legacy, endpoint: 'bad-url' })).rejects.toThrow();
    expect(legacy).toEqual(before); expect((await store.snapshot()).services).toEqual([]);
    await store.migrateLegacy('a', legacy); let data = await store.snapshot();
    data = await store.mutate({ action: 'bind', expectedRevision: data.revision, partnerId: 'a', modelId: data.models[0].id });
    await store.migrateLegacy('a', { ...legacy, model: 'obsolete-renderer-value' });
    expect(await store.snapshot()).toEqual(data);
    await writeFile(file, '{corrupt');
    await expect(store.migrateLegacy('a', legacy)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{corrupt');
  });
  it('does not let background renderer sync replace a newer authoritative binding', async () => {
    const { store } = await setup(); await store.migrateLegacy('a', legacy);
    let data = await store.snapshot(); const original = data.models[0];
    data = await store.mutate({ action: 'model', expectedRevision: data.revision, value: { ...original, id: 'new-model', model: 'next-model' } });
    data = await store.mutate({ action: 'bind', expectedRevision: data.revision, partnerId: 'a', modelId: 'new-model' });
    await store.migrateLegacy('a', { ...legacy, modelId: original.id });
    expect(await store.snapshot()).toEqual(data); expect((await store.resolve('a', legacy)).model).toBe('next-model');
    await store.migrateLegacy('a', { ...legacy, modelId: original.id }, true);
    expect((await store.resolve('a', legacy)).model).toBe(legacy.model);
  });
  it('preserves authoritative advanced settings and disabled tools when legacy profile metadata is saved again', async () => {
    const { store } = await setup(); await store.migrateLegacy('a', legacy);
    let data = await store.snapshot();
    data = await store.mutate({ action: 'service', expectedRevision: data.revision, value: { ...data.services[0], name: '用户连接名', settings: { auth: 'bearer', headerTimeoutMs: 90000 } } });
    await store.mutate({ action: 'model', expectedRevision: data.revision, value: { ...data.models[0], tools: false, settings: { autoCompact: false, temperature: 0.2 } } });
    await store.migrateLegacy('a', { ...legacy, attachmentCapabilities: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } }, true);
    const saved = await store.snapshot(); expect(saved.services[0]).toMatchObject({ name: '用户连接名', settings: { headerTimeoutMs: 90000 } }); expect(saved.models[0]).toMatchObject({ tools: false, settings: { temperature: 0.2 } });
  });
  it('preserves dialogue, summaries and completed tool results across bindings, with native state scoped to a binding', async () => {
    const { directory } = await setup(); const sessions = new ApiAgentSessionStore(path.join(directory, 'sessions'));
    const session: ApiAgentSession = { version: 1, partnerId: 'a', conversationId: 'c', provider: 'deepseek', bindingKey: 'old', updatedAt: '', compaction: { summary: '已确认的目标', throughClientMessageId: 'older', createdAt: '' }, turns: [{ clientMessageId: 'one', userContent: '读取文件', completedAt: '', messages: [
      { role: 'assistant', content: '', reasoningContent: 'private', native: { binding: 'old', items: [{ signature: 'opaque' }] }, toolCalls: [{ id: 'call', name: 'read_file', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call', content: 'already done' }, { role: 'assistant', content: '公开回答', reasoningContent: '' },
    ] }] };
    await sessions.remember(session);
    const restored = (await sessions.load('a', 'c'))!;
    expect(bindApiSession(restored, 'deepseek', 'old').turns).toEqual(session.turns);
    const switched = bindApiSession(restored, 'openai', 'new');
    expect(switched.compaction).toEqual(session.compaction);
    expect(switched.turns[0].messages[1]).toEqual(session.turns[0].messages[1]);
    expect(switched.turns[0].messages[0]).not.toHaveProperty('native');
    expect(JSON.stringify(switched)).not.toContain('private');
    await sessions.remember(switched); expect((await sessions.load('a', 'c'))?.turns).toEqual(switched.turns);
  });
});
