import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiExtensionStore } from '../../src/main/api/ApiExtensionStore';
import { ApiToolRegistry, assertApiToolAllowed } from '../../src/main/api/ApiToolRegistry';
import { API_EXTENSION_CREDENTIAL_PREFIX, CredentialStore } from '../../src/main/security/CredentialStore';
import type { ApiExtensionsSnapshot, ExtensionUpsertRequest } from '../../src/shared/apiExtensions';

const directories: string[] = [];
const manual = { permissionMode: 'manual' as const, planMode: 'default' as const };
const configuration = { type: 'mcp_stdio' as const, command: 'never-executed', args: ['--example'], cwd: 'K:\\synthetic' };
afterEach(async () => {
  const temp = (await realpath(os.tmpdir())).toLowerCase();
  for (const directory of directories.splice(0)) {
    const target = await realpath(directory);
    expect(path.dirname(target).toLowerCase()).toBe(temp);
    expect(path.basename(target).startsWith('asterium-s2-unit-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-s2-unit-')); directories.push(directory);
  const file = path.join(directory, 'extensions.json');
  const credentialsFile = path.join(directory, 'credentials.json');
  const credentials = new CredentialStore(credentialsFile, {
    isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => value.toString().slice(10),
  });
  const scoped = credentials.forNamespace(API_EXTENSION_CREDENTIAL_PREFIX);
  const eligible = vi.fn((id: string) => ['api-one', 'api-two'].includes(id));
  const cleanupError = vi.fn();
  const store = new ApiExtensionStore(file, scoped, eligible, cleanupError);
  const add = async (overrides: Partial<ExtensionUpsertRequest> = {}) => store.upsert({ expectedVersion: (await store.get()).version, name: 'Example', enabled: true, configuration, ...overrides });
  const update = async (state: ApiExtensionsSnapshot, overrides: Partial<ExtensionUpsertRequest> = {}) => store.upsert({ expectedVersion: state.version, id: state.extensions[0].id, name: state.extensions[0].name, enabled: state.extensions[0].enabled, configuration: state.extensions[0].configuration, ...overrides });
  const trust = async () => {
    let state = await store.get(); const entry = state.extensions[0];
    state = await store.setTrust({ expectedVersion: state.version, id: entry.id, action: 'request' });
    await store.recordInventory(entry.id, state.extensions[0].generation, [{ name: 'write', inputSchema: { type: 'object' } }]);
    const token = await store.prepareTrustApproval(entry.id, manual);
    return store.confirmTrustApproval(token, manual);
  };
  return { directory, file, credentialsFile, credentials, scoped, eligible, store, add, update, trust, cleanupError };
}

describe('API extension configuration and trust authority (S2)', () => {
  it('keeps binding tombstones across reload, without invalidating other partner/extension pairs', async () => {
    const s = await setup(); let state = await s.add(); const first = state.extensions[0].id;
    state = await s.add({ name: 'Second' }); const second = state.extensions[1].id;
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [first, second] });
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-two', extensionIds: [first] });
    const before = await s.store.bindingRevision('api-one', first);
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [second] });
    const fresh = new ApiExtensionStore(s.file, s.scoped, s.eligible);
    state = await fresh.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [first, second] });
    expect(await fresh.bindingRevision('api-one', first)).toBe(before! + 2);
    expect(await fresh.bindingRevision('api-one', second)).toBe(1); expect(await fresh.bindingRevision('api-two', first)).toBe(1);
    const dispatch = vi.fn(async () => 'must-not-start');
    await expect(fresh.dispatchForPartner('api-one', first, state.extensions[0].generation, dispatch, undefined, before)).rejects.toThrow('BINDING_CHANGED');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('loads legacy binding records and expires partner-bound trust tokens after rebind', async () => {
    const s = await setup(); let state = await s.add(); const id = state.extensions[0].id;
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [id] });
    const disk = JSON.parse(await readFile(s.file, 'utf8')); delete disk.bindings[0].revisions; await writeFile(s.file, JSON.stringify(disk));
    const fresh = new ApiExtensionStore(s.file, s.scoped, s.eligible); expect(await fresh.bindingRevision('api-one', id)).toBe(0);
    state = await fresh.setTrust({ expectedVersion: state.version, id, action: 'request' });
    await fresh.recordInventory(id, state.extensions[0].generation, []);
    const token = await fresh.prepareTrustApproval(id, manual, 'api-one'); state = await fresh.get();
    state = await fresh.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [] });
    expect(state.bindings).toEqual([]);
    await fresh.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [id] });
    await expect(fresh.confirmTrustApproval(token, manual, 'api-one')).rejects.toThrow('APPROVAL_EXPIRED');
    expect((await fresh.get()).extensions[0].trust).toBe('pending');
  });
  it('defaults empty and persists MCP/skill identities and bindings across a fresh store', async () => {
    const s = await setup(); expect(await s.store.get()).toEqual({ version: 0, extensions: [], bindings: [] });
    let state = await s.add(); const first = state.extensions[0].id;
    state = await s.add({ configuration: { type: 'skill', directory: 'K:\\skills\\example' }, name: 'Skill' });
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: state.extensions.map((entry) => entry.id) });
    const fresh = new ApiExtensionStore(s.file, s.scoped, s.eligible);
    expect(await fresh.get()).toEqual(state);
    expect(state.extensions.map((entry) => entry.kind)).toEqual(['mcp', 'skill']);
    expect((await fresh.enabledForPartner('api-one')).map((entry) => entry.id)).toContain(first);
    expect(await fresh.enabledForPartner('api-two')).toEqual([]);
  });

  it.each(['local-cli', 'existing-thread', 'removed-api', '__proto__'])('rejects bindings for ineligible partner %s', async (partnerId) => {
    const s = await setup(); const state = await s.add();
    await expect(s.store.setBinding({ expectedVersion: state.version, partnerId, extensionIds: [state.extensions[0].id] })).rejects.toThrow('PARTNER_INELIGIBLE');
    expect((await s.store.get()).bindings).toEqual([]);
  });

  it('rechecks partner eligibility and global enabled state for future runtime access', async () => {
    const s = await setup(); let state = await s.add();
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [state.extensions[0].id] });
    expect(await s.store.enabledForPartner('api-one')).toHaveLength(1);
    s.eligible.mockReturnValue(false); expect(await s.store.enabledForPartner('api-one')).toEqual([]);
    s.eligible.mockReturnValue(true); await s.update(state, { enabled: false });
    expect(await s.store.enabledForPartner('api-one')).toEqual([]);
  });

  it('encrypts env/header values, hides credential references, preserves omitted secrets and clears explicitly', async () => {
    const s = await setup(); let state = await s.add({ secrets: { API_KEY: 's2-env-secret' } });
    const id = state.extensions[0].id;
    expect(JSON.stringify(state)).not.toContain('s2-env-secret'); expect(JSON.stringify(state)).not.toContain('credentialRef');
    expect(await readFile(s.file, 'utf8')).not.toContain('s2-env-secret');
    expect(await readFile(s.credentialsFile, 'utf8')).not.toContain('s2-env-secret');
    expect(await s.store.connectionSecrets(id, state.extensions[0].generation)).toEqual({ API_KEY: 's2-env-secret' });
    state = await s.update(state, { name: 'Display rename' });
    expect(await s.store.connectionSecrets(id, state.extensions[0].generation)).toEqual({ API_KEY: 's2-env-secret' });
    state = await s.update(state, { configuration: { type: 'mcp_http', url: 'http://127.0.0.1:8765/mcp' } });
    expect(state.extensions[0].hasSecrets).toBe(false);
    state = await s.update(state, { secrets: { Authorization: 'Bearer s2-header-secret' } });
    expect(state.extensions[0].secretNames).toEqual(['Authorization']);
    expect(await readFile(s.file, 'utf8')).not.toContain('s2-header-secret');
    state = await s.update(state, { secrets: null });
    expect(state.extensions[0].hasSecrets).toBe(false);
    expect(JSON.parse(await readFile(s.credentialsFile, 'utf8')).credentials).toEqual({});
  });

  it('rotates only owned credentials and removes references/bindings without touching other credentials', async () => {
    const s = await setup(); await s.credentials.save('unrelated', 'provider-original');
    let state = await s.add({ secrets: { KEY: 'one' } });
    const firstRef = JSON.parse(await readFile(s.file, 'utf8')).extensions[0].credentialRef;
    state = await s.update(state, { secrets: { KEY: 'two' } });
    expect(await s.scoped.get(firstRef)).toBeUndefined();
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [state.extensions[0].id] });
    state = await s.store.remove({ expectedVersion: state.version, id: state.extensions[0].id });
    expect(state.extensions).toEqual([]); expect(state.bindings).toEqual([]);
    expect(await s.credentials.get('provider-original')).toBe('unrelated');
    expect(Object.keys(JSON.parse(await readFile(s.credentialsFile, 'utf8')).credentials)).toEqual(['provider-original']);
  });

  it('requires explicit pending -> Main approval -> trusted, persisted globally while partner enabling remains separate', async () => {
    const s = await setup(); let state = await s.add(); const id = state.extensions[0].id;
    expect(state.extensions[0].trust).toBe('untrusted');
    state = await s.store.setTrust({ expectedVersion: state.version, id, action: 'request' });
    expect(state.extensions[0].trust).toBe('pending');
    await expect(s.store.prepareTrustApproval(id, manual)).rejects.toThrow('TRUST_NOT_READY');
    state = await s.trust(); expect(state.extensions[0].trust).toBe('trusted');
    const fresh = new ApiExtensionStore(s.file, s.scoped, s.eligible);
    expect((await fresh.get()).extensions[0].trust).toBe('trusted');
    expect(await fresh.enabledForPartner('api-two')).toEqual([]);
  });

  it('does not activate trust for allow-once and tokens cannot survive restart or be reused', async () => {
    const s = await setup(); let state = await s.add(); const id = state.extensions[0].id;
    state = await s.store.setTrust({ expectedVersion: state.version, id, action: 'request' });
    await s.store.recordInventory(id, state.extensions[0].generation, []);
    const token = await s.store.prepareTrustApproval(id, manual);
    expect((await s.store.get()).extensions[0].trust).toBe('pending');
    const fresh = new ApiExtensionStore(s.file, s.scoped, s.eligible);
    await expect(fresh.confirmTrustApproval(token, manual)).rejects.toThrow('APPROVAL_EXPIRED');
    await s.store.confirmTrustApproval(token, manual);
    await expect(s.store.confirmTrustApproval(token, manual)).rejects.toThrow('APPROVAL_EXPIRED');
  });

  it('discards allow-once/deny/cancel candidates and rechecks policy at confirmation', async () => {
    const s = await setup(); let state = await s.add(); const id = state.extensions[0].id;
    state = await s.store.setTrust({ expectedVersion: state.version, id, action: 'request' });
    await s.store.recordInventory(id, state.extensions[0].generation, []);
    const cancelled = await s.store.prepareTrustApproval(id, manual);
    s.store.discardTrustApproval(cancelled);
    await expect(s.store.confirmTrustApproval(cancelled, manual)).rejects.toThrow('APPROVAL_EXPIRED');
    for (const policy of [{ permissionMode: 'read_only' as const, planMode: 'default' as const }, { permissionMode: 'full' as const, planMode: 'plan' as const }]) {
      const token = await s.store.prepareTrustApproval(id, manual);
      expect(() => s.store.confirmTrustApproval(token, policy)).toThrow('POLICY_BLOCKED');
      await expect(s.store.confirmTrustApproval(token, manual)).rejects.toThrow('APPROVAL_EXPIRED');
    }
    expect((await s.store.get()).extensions[0].trust).toBe('pending');
  });

  it('invalidates a pending approval when discovered capabilities change', async () => {
    const s = await setup(); let state = await s.add(); const id = state.extensions[0].id;
    state = await s.store.setTrust({ expectedVersion: state.version, id, action: 'request' });
    await s.store.recordInventory(id, state.extensions[0].generation, []); state = await s.store.get();
    const token = await s.store.prepareTrustApproval(id, manual);
    await s.store.recordInventory(id, state.extensions[0].generation, [{ name: 'new' }]);
    await expect(s.store.confirmTrustApproval(token, manual)).rejects.toThrow('APPROVAL_EXPIRED');
    expect((await s.store.get()).extensions[0].trust).toBe('pending');
  });

  it('treats explicitly undefined optional fields the same as omitted fields at IPC/JSON boundaries', async () => {
    const s = await setup(); await s.add({ configuration: { type: 'mcp_stdio', command: 'never-executed', args: [], cwd: undefined } });
    let state = await s.trust();
    state = await s.update(state, { configuration: { type: 'mcp_stdio', command: 'never-executed', args: [], cwd: undefined } });
    expect(state.extensions[0].trust).toBe('trusted');
    await s.store.recordInventory(state.extensions[0].id, state.extensions[0].generation, [{ name: 'write', description: undefined, inputSchema: { type: 'object' } }]);
    expect((await s.store.get()).extensions[0].trust).toBe('trusted');
  });

  it.each([
    { permissionMode: 'read_only' as const, planMode: 'default' as const },
    { permissionMode: 'manual' as const, planMode: 'plan' as const },
    { permissionMode: 'full' as const, planMode: 'default' as const },
  ])('cannot activate trust under policy %j', async (policy) => {
    const s = await setup(); await s.add(); const state = await s.trust();
    expect(() => s.store.prepareTrustApproval(state.extensions[0].id, policy)).toThrow();
    expect(() => s.store.confirmTrustApproval('forged', policy)).toThrow();
  });

  it('revokes immediately for future lookups and rejects approval captured before revoke/re-request', async () => {
    const s = await setup(); await s.add(); let state = await s.trust(); const id = state.extensions[0].id;
    state = await s.store.setTrust({ expectedVersion: state.version, id, action: 'revoke' });
    expect(state.extensions[0].trust).toBe('untrusted');
    state = await s.store.setTrust({ expectedVersion: state.version, id, action: 'request' });
    const token = await s.store.prepareTrustApproval(id, manual);
    state = await s.store.setTrust({ expectedVersion: state.version, id, action: 'revoke' });
    state = await s.store.setTrust({ expectedVersion: state.version, id, action: 'request' });
    expect(state.extensions[0].trust).toBe('pending');
    await expect(s.store.confirmTrustApproval(token, manual)).rejects.toThrow('APPROVAL_EXPIRED');
    const newToken = await s.store.prepareTrustApproval(id, manual);
    expect((await s.store.confirmTrustApproval(newToken, manual)).extensions[0].trust).toBe('trusted');
  });

  it.each(['command', 'args', 'cwd', 'secrets', 'disable'] as const)('invalidates trust and in-flight approvals after critical %s change', async (field) => {
    const s = await setup(); await s.add(); let state = await s.trust();
    const overrides = field === 'command' ? { configuration: { ...configuration, command: 'other' } }
      : field === 'args' ? { configuration: { ...configuration, args: ['different'] } }
      : field === 'cwd' ? { configuration: { ...configuration, cwd: 'D:\\different' } }
      : field === 'secrets' ? { secrets: { KEY: 'replacement' } } : { enabled: false };
    state = await s.update(state, overrides);
    expect(state.extensions[0].trust).toBe('pending'); expect(state.extensions[0].inventoryKnown).toBe(false);
    await expect(s.store.prepareTrustApproval(state.extensions[0].id, manual)).rejects.toThrow('TRUST_NOT_READY');
  });

  it('invalidates HTTP endpoint and skill directory/content trust, while display rename and equivalent manifest key order preserve it', async () => {
    const s = await setup(); await s.add({ configuration: { type: 'mcp_http', url: 'http://localhost:8080/mcp' } });
    let state = await s.trust(); const id = state.extensions[0].id;
    state = await s.update(state, { name: 'Renamed only' }); expect(state.extensions[0].trust).toBe('trusted');
    await s.store.recordInventory(id, state.extensions[0].generation, [{ inputSchema: { type: 'object' }, name: 'write' }]);
    state = await s.store.get(); expect(state.extensions[0].trust).toBe('trusted');
    await s.store.recordInventory(id, state.extensions[0].generation, [{ name: 'new-tool' }]);
    state = await s.store.get(); expect(state.extensions[0].trust).toBe('pending');
    state = await s.update(state, { configuration: { type: 'mcp_http', url: 'http://localhost:9090/mcp' } });
    expect(state.extensions[0].inventoryKnown).toBe(false);
    await expect(s.update(state, { configuration: { type: 'skill', directory: 'K:\\skills' } })).rejects.toThrow('KIND_IMMUTABLE');
    const skill = await setup(); await skill.add({ configuration: { type: 'skill', directory: 'K:\\skills' } });
    let skills = await skill.trust();
    await skill.store.recordInventory(skills.extensions[0].id, skills.extensions[0].generation, { scripts: { 'run.py': 'content-sha256' } });
    skills = await skill.store.get(); expect(skills.extensions[0].trust).toBe('pending');
    skills = await skill.update(skills, { configuration: { type: 'skill', directory: 'K:\\other-skills' } });
    expect(skills.extensions[0].inventoryKnown).toBe(false);
  });

  it('rejects approval after concurrent reconfiguration, stale catalog observations, and stale management versions', async () => {
    const s = await setup(); let state = await s.add(); const id = state.extensions[0].id;
    state = await s.store.setTrust({ expectedVersion: state.version, id, action: 'request' });
    await s.store.recordInventory(id, state.extensions[0].generation, []); state = await s.store.get();
    const token = await s.store.prepareTrustApproval(id, manual); const oldGeneration = state.extensions[0].generation;
    const operations = await Promise.allSettled([
      s.update(state, { configuration: { ...configuration, args: ['new'] } }),
      s.store.confirmTrustApproval(token, manual),
      s.update(state, { name: 'stale overwrite' }),
    ]);
    expect(operations.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    await expect(s.store.recordInventory(id, oldGeneration, [])).rejects.toThrow('STALE_GENERATION');
    await expect(s.store.connectionSecrets(id, oldGeneration)).rejects.toThrow('STALE_GENERATION');
    expect((await s.store.get()).extensions[0].trust).toBe('pending');
  });

  it('serializes concurrent creates using expectedVersion without losing a successful write', async () => {
    const s = await setup();
    const results = await Promise.allSettled([s.add({ expectedVersion: 0 }), s.add({ expectedVersion: 0 })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await s.store.get()).extensions).toHaveLength(1);
  });

  it.each([
    { trust: 'trusted' }, { credentialRef: 'provider-original' }, { inventoryDigest: 'forged' }, { action: 'activate' },
    { configuration: { type: 'mcp_stdio', command: 'x', args: [], cwd: '..\\relative' } },
    { configuration: { type: 'mcp_http', url: 'file:///secret' } },
    { configuration: { type: 'mcp_http', url: 'https://user:secret@example.com/mcp' } },
    { configuration: { type: 'skill', directory: 'K:\\skills' }, secrets: { KEY: 'bad' } },
    { configuration: { type: 'mcp_http', url: 'https://example.com/mcp' }, secrets: { Authorization: 'bad\r\nInjected: true' } },
    { configuration: { type: 'mcp_http', url: 'https://example.com/mcp' }, secrets: { Authorization: 'a', authorization: 'b' } },
    { configuration: { type: 'mcp_http', url: 'https://example.com/mcp' }, secrets: { 'Mcp-Session-Id': 'must-not-resume-another-context' } },
    { configuration: { type: 'mcp_http', url: 'https://example.com/mcp' }, secrets: { 'Mcp-Protocol-Version': 'must-not-override-negotiation' } },
  ])('rejects forged control fields or invalid config %#', async (overrides) => {
    const s = await setup(); expect(() => s.store.upsert({ expectedVersion: 0, name: 'bad', enabled: true, configuration, ...overrides })).toThrow();
    expect((await s.store.get()).version).toBe(0);
  });

  it('fails closed on corrupt/foreign credential references and never deletes other credentials', async () => {
    const s = await setup(); await s.credentials.save('original', 'provider-original'); await s.add();
    const file = JSON.parse(await readFile(s.file, 'utf8')); file.extensions[0].credentialRef = 'provider-original'; file.extensions[0].secretNames = ['KEY'];
    await writeFile(s.file, JSON.stringify(file));
    await expect(s.store.get()).rejects.toThrow();
    await expect(s.store.remove({ expectedVersion: file.version, id: file.extensions[0].id })).rejects.toThrow();
    expect(await s.credentials.get('provider-original')).toBe('original');
    await writeFile(s.file, '{'); await expect(s.store.get()).rejects.toThrow();
  });

  it('rolls back newly saved credentials when configuration commit fails', async () => {
    const s = await setup(); await s.add({ secrets: { KEY: 'old' } }); const state = await s.store.get();
    const original = JSON.parse(await readFile(s.file, 'utf8')).extensions[0].credentialRef;
    const impossible = path.join(s.directory, 'directory-target'); await mkdir(impossible);
    await writeFile(path.join(impossible, 'canary'), 'keep');
    // Point to a valid readable configuration, then switch path just before the write.
    let filePath = s.file;
    const originalSave = s.scoped.save.bind(s.scoped);
    const save = vi.spyOn(s.scoped, 'save').mockImplementation(async (secret, ref) => {
      filePath = impossible;
      return originalSave(secret, ref);
    });
    const failing = new ApiExtensionStore(() => filePath, s.scoped, s.eligible);
    await expect(failing.upsert({ expectedVersion: state.version, id: state.extensions[0].id, name: 'change', enabled: true, configuration, secrets: { KEY: 'new' } })).rejects.toThrow();
    save.mockRestore();
    expect(await s.scoped.get(original)).toBe(JSON.stringify({ KEY: 'old' }));
    expect(Object.keys(JSON.parse(await readFile(s.credentialsFile, 'utf8')).credentials)).toEqual([original]);
    expect(await s.store.get()).toEqual(state);
  });

  it('reports cleanup failure after committed removal without restoring configuration or claiming deletion failed', async () => {
    const s = await setup(); const state = await s.add({ secrets: { KEY: 'old' } });
    vi.spyOn(s.scoped, 'delete').mockRejectedValueOnce(new Error('unavailable'));
    expect((await s.store.remove({ expectedVersion: state.version, id: state.extensions[0].id })).extensions).toEqual([]);
    expect(s.cleanupError).toHaveBeenCalledOnce();
  });

  it('keeps registry read-only and Plan guards authoritative even when extension metadata is trusted', async () => {
    const s = await setup(); await s.add(); expect((await s.trust()).extensions[0].trust).toBe('trusted');
    const registry = new ApiToolRegistry();
    const execute = vi.fn(async () => ({ content: 'must not execute' }));
    registry.register({ definition: { name: 'extension_write', description: 'external', parameters: { type: 'object', properties: {}, additionalProperties: false } }, source: 'workspace', allowInPlan: true,
      describe: () => ({ mutates: true, action: 'external_side_effect', risk: 'high', summary: 'write', targets: [] }), execute });
    const prepared = registry.prepare('extension_write', {});
    expect(() => assertApiToolAllowed(prepared, { permissionMode: 'read_only', planMode: 'default' as const })).toThrow();
    expect(() => assertApiToolAllowed(prepared, { permissionMode: 'full', planMode: 'plan' as const })).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
