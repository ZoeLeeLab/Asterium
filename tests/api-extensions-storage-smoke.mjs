import { runAutoTest, spawnTestProcess as spawn, testRm as rm, autoTestEvidence, createTestNetServer } from './helpers/autoTest.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';

import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

await runAutoTest(async () => {
// S2 packaged Main/preload persistence smoke. Synthetic data only; no MCP launch or model requests.








const root = path.resolve(import.meta.dirname, '..');
const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-s2-storage-'));
const evidence = autoTestEvidence('s2-storage');
let child;
let browser;
let page;
let launchFailure;
const result = { isolatedUserData: true, noModelOrMcpRequests: true, cases: {} };
try {
  await mkdir(evidence, { recursive: true });
  await launch();
  const first = await page.evaluate(async () => {
    const api = globalThis.asteriumExtensions;
    if (!api || typeof api.get !== 'function') throw new Error('S2 preload bridge missing');
    if ('confirmTrustApproval' in api || 'connectionSecrets' in api || 'recordInventory' in api) throw new Error('Main-only API exposed');
    const capture = async (operation) => { try { await operation(); return ''; } catch (error) { return error.message; } };
    let state = await api.get();
    if (state.version !== 0 || state.extensions.length) throw new Error('Isolated store must start empty');
    const configuration = { type: 'mcp_stdio', command: 'asterium-s2-command-that-must-never-run', args: [], cwd: 'K:\\synthetic-unread-directory' };
    state = await api.upsert({ expectedVersion: state.version, name: 'S2 MCP', enabled: true, configuration, secrets: { API_TOKEN: 'synthetic-s2-secret-one' } });
    const id = state.extensions[0].id;
    const rejectedTrust = await capture(() => api.setTrust({ expectedVersion: state.version, id, action: 'activate' }));
    const rejectedRef = await capture(() => api.upsert({ expectedVersion: state.version, id, name: 'Hijack', enabled: true, configuration, credentialRef: 'provider-original' }));
    const stale = await capture(() => api.setTrust({ expectedVersion: 0, id, action: 'request' }));
    state = await api.setTrust({ expectedVersion: state.version, id, action: 'request' });
    if (state.extensions[0].trust !== 'pending') throw new Error('Whitelist request must remain pending');
    const pendingVersion = state.version;
    state = await api.setTrust({ expectedVersion: state.version, id, action: 'revoke' });
    const staleAfterRevoke = await capture(() => api.setTrust({ expectedVersion: pendingVersion, id, action: 'request' }));
    const profiles = [
      { id: 's2-api', sourceMode: 'api_partner', available: true, runtime: { kind: 'api', connection: { provider: 'deepseek', endpoint: 'https://example.invalid', model: 'synthetic', credentialRef: 'unused-s2-model' } } },
      { id: 's2-removed', sourceMode: 'api_partner', available: false, runtime: { kind: 'api', connection: { provider: 'deepseek', endpoint: 'https://example.invalid', model: 'synthetic', credentialRef: 'unused-s2-model' } } },
      { id: 's2-local', sourceMode: 'local_cli', available: true, runtime: { kind: 'local', adapterType: 'claude_code', workspaceGrantIds: [] } },
      { id: 's2-existing', sourceMode: 'existing_thread', available: true, runtime: { kind: 'unsupported' } },
    ];
    for (const profile of profiles) await globalThis.asteriumAgents.savePartnerProfile({
      partnerId: profile.id, sourceMode: profile.sourceMode,
      publicIdentity: { displayName: profile.id, introduction: 'S2 synthetic profile', expertise: 'test', mentionName: profile.id },
      management: { userProfile: false, personality: false, memoryMode: 'none' },
      connectionSettings: { __studioRuntime: { persist: true, available: profile.available, runtime: profile.runtime } },
    });
    const rejectedBindings = [];
    for (const partnerId of ['s2-removed', 's2-local', 's2-existing', 's2-unknown']) rejectedBindings.push(await capture(() => api.setBinding({ expectedVersion: state.version, partnerId, extensionIds: [id] })));
    state = await api.setBinding({ expectedVersion: state.version, partnerId: 's2-api', extensionIds: [id] });
    state = await api.upsert({ expectedVersion: state.version, name: 'S2 Skill', enabled: true, configuration: { type: 'skill', directory: 'K:\\synthetic-unread-skills' } });
    state = await api.setTrust({ expectedVersion: state.version, id: state.extensions[1].id, action: 'request' });
    return { state, rejectedTrust, rejectedRef, stale, staleAfterRevoke, rejectedBindings };
  });
  assert.ok(first.rejectedTrust && first.rejectedRef);
  assert.match(first.stale, /VERSION_CONFLICT/);
  assert.match(first.staleAfterRevoke, /VERSION_CONFLICT/);
  assert.equal(first.rejectedBindings.length, 4);
  assert.ok(first.rejectedBindings.every((error) => /PARTNER_INELIGIBLE/.test(error)));
  assert.equal(first.state.extensions[0].trust, 'untrusted');
  assert.equal(first.state.extensions[1].trust, 'pending');
  assert.ok(!JSON.stringify(first.state).includes('synthetic-s2-secret-one'));
  assert.ok(!JSON.stringify(first.state).includes('credentialRef'));
  const config = await readFile(path.join(userData, 'api-extensions.v1.json'), 'utf8');
  const encrypted = await readFile(path.join(userData, 'secure-credentials.v1.json'), 'utf8');
  assert.ok(!config.includes('synthetic-s2-secret-one'));
  assert.ok(!encrypted.includes('synthetic-s2-secret-one'));
  assert.ok(JSON.parse(config).extensions[0].credentialRef.startsWith('api-extension-extension-'));
  const bypassResults = await page.evaluate(async (credentialRef) => {
    const api = globalThis.asteriumAgents;
    const results = [];
    for (const operation of [
      () => api.saveApiCredential('forged-extension-secret', credentialRef),
      () => api.apiCredentialStatus(credentialRef),
      () => api.deleteApiCredential(credentialRef),
      () => api.bridgeCredentialStatus(credentialRef),
      () => api.deleteBridgeCredential(credentialRef),
      () => api.listApiModels('deepseek', 'https://api.deepseek.com/chat/completions', credentialRef),
    ]) {
      try { await operation(); results.push('UNEXPECTED_SUCCESS'); } catch (error) { results.push(error.message); }
    }
    return results;
  }, JSON.parse(config).extensions[0].credentialRef);
  assert.ok(bypassResults.every((error) => /CREDENTIAL_NAMESPACE_RESERVED/.test(error)), 'Legacy IPC bypass must be rejected before credential access or network request');
  assert.equal(await readFile(path.join(userData, 'secure-credentials.v1.json'), 'utf8'), encrypted);
  result.cases.crudAndPrivatePreload = 'passed';
  result.cases.osEncryptedSecrets = 'passed';
  result.cases.legacyCredentialBypassBlocked = 'passed';
  result.cases.apiOnlyBindings = 'passed';
  result.cases.pendingRevokeAndStaleWrites = 'passed';

  await close();
  await launch();
  const restarted = await page.evaluate(() => globalThis.asteriumExtensions.get());
  assert.deepEqual(restarted, first.state);
  result.cases.restartPersistence = 'passed';
  await page.evaluate(async () => {
    const api = globalThis.asteriumExtensions;
    let state = await api.get(); const entry = state.extensions[0];
    state = await api.upsert({ expectedVersion: state.version, id: entry.id, name: 'Rotated', enabled: true, configuration: entry.configuration, secrets: { API_TOKEN: 'synthetic-s2-secret-two' } });
    state = await api.remove({ expectedVersion: state.version, id: entry.id });
    if (state.bindings.length || state.extensions.length !== 1) throw new Error('Removal did not clean binding');
    state = await api.remove({ expectedVersion: state.version, id: state.extensions[0].id });
    if (state.extensions.length) throw new Error('Removal did not persist');
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(userData, 'secure-credentials.v1.json'), 'utf8')).credentials, {});
  result.cases.rotationRemovalAndCredentialCleanup = 'passed';
} finally {
  await close();
  const temp = await realpath(os.tmpdir()); const target = await realpath(userData);
  assert.equal(path.dirname(target).toLowerCase(), temp.toLowerCase());
  assert.ok(path.basename(target).startsWith('asterium-s2-storage-'));
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
result.temporaryDataRemoved = true;
await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

async function launch() {
  launchFailure = undefined;
  const server = createTestNetServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve));
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore' });
  child.once('error', (error) => { launchFailure = error; });
  await until(async () => {
    if (launchFailure) throw launchFailure;
    if (child.exitCode !== null) throw new Error('Application exited before ready');
    return fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok).catch(() => false);
  }, 'debugger');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await until(() => { page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:')); return Boolean(page); }, 'page');
  await page.getByLabel('主要页面').waitFor();
  await page.waitForFunction(async () => Boolean(globalThis.asteriumExtensions && await globalThis.asteriumConversations?.openHistory?.(true)));
}
async function close() {
  await browser?.close().catch(() => {}); browser = undefined;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve); killer.once('error', resolve);
    }); else child.kill('SIGTERM');
    await until(() => child.exitCode !== null || child.signalCode !== null, 'child exit');
  }
  child = undefined;
}
async function until(probe, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 150)); }
  throw new Error(`Timed out waiting for ${label}`);
}
});
