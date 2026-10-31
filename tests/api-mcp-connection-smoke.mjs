// Packaged S3 transport smoke: local fixtures, isolated user data, no model calls or tools/call.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-s3-mcp-'));
const workspace = await mkdtemp(path.join(os.tmpdir(), 'asterium-s2-mcp-workspace-'));
const workspaceGrantId = 'workspace-33333333-3333-3333-3333-333333333333';
const log = path.join(userData, 'stdio-lifecycle.jsonl'); const control = path.join(userData, 'tools.json');
const evidence = path.join(root, '.qa', 's3-mcp');
const tools = [{ name: 'fixture_inspect', description: 'Local fixture', inputSchema: { type: 'object', properties: {} } }];
const requests = []; let child; let browser; let page; let launchFailure; let diagnostics = '';
const result = { isolatedUserData: true, modelRequests: false, toolExecution: false, cases: {} };
const http = createServer(async (request, response) => {
  const authenticated = request.headers.authorization === 'Bearer s3-encrypted-header-fixture';
  const recorded = { method: request.method, authenticated }; requests.push(recorded);
  if (request.method === 'DELETE') { response.writeHead(204).end(); return; }
  if (request.method === 'GET') { response.writeHead(405).end(); return; }
  if (!authenticated) { response.writeHead(401).end(); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  const message = JSON.parse(body); recorded.rpc = message.method;
  if (message.id === undefined) { response.writeHead(202).end(); return; }
  const payload = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 's3-packaged-fixture', version: '1' } }
    : { tools };
  response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's3-isolated-session' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: payload }));
});
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${http.address().port}/mcp`;
try {
  await mkdir(evidence, { recursive: true }); await writeFile(control, JSON.stringify({ tools }));
  await writeFile(path.join(userData, 'workspace-grants.v1.json'), JSON.stringify({ version: 1, grants: { [workspaceGrantId]: workspace } }));
  await launch();
  const created = await page.evaluate(async ({ command, args, cwd, endpoint, workspaceGrantId }) => {
    const api = globalThis.asteriumExtensions;
    let state = await api.get();
    state = await api.upsert({ expectedVersion: state.version, name: 'S3 stdio', enabled: true, configuration: { type: 'mcp_stdio', command, args, cwd, workspaceGrantId }, secrets: { FIXTURE_TOKEN: 's3-encrypted-env-fixture' } });
    state = await api.upsert({ expectedVersion: state.version, name: 'S3 HTTP', enabled: true, configuration: { type: 'mcp_http', url: endpoint }, secrets: { Authorization: 'Bearer s3-encrypted-header-fixture' } });
    if ((await api.mcpStatus()).length) throw new Error('Configuration must not auto-connect');
    const status = [];
    for (const entry of state.extensions) status.push(await api.connectMcp({ id: entry.id, expectedGeneration: entry.generation }));
    return { state: await api.get(), status };
  }, { command: process.execPath, args: [path.join(root, 'tests', 'fixtures', 'api-mcp-server.mjs'), log, control], cwd: workspace, endpoint, workspaceGrantId });
  assert.ok(created.status.every((status) => status.state === 'ready' && status.toolCount === 1 && status.backend === 'native' && status.sandboxed === false));
  assert.ok(created.state.extensions.every((entry) => entry.trust === 'untrusted' && entry.inventoryKnown));
  let events = await lifecycle(); const stdioPid = events[0].pid;
  assert.equal(events[0].secretHash, createHash('sha256').update('s3-encrypted-env-fixture').digest('hex'));
  assert.ok(requests.length && requests.every((request) => request.authenticated));
  result.cases.realStdioAndHttpHandshake = 'passed'; result.cases.encryptedEnvAndHeadersResolved = 'passed';
  const storeBytes = await readFile(path.join(userData, 'api-extensions.v1.json'), 'utf8');
  const ciphertext = await readFile(path.join(userData, 'secure-credentials.v1.json'), 'utf8');
  assert.ok(!storeBytes.includes('s3-encrypted-') && !ciphertext.includes('s3-encrypted-'));
  await writeFile(control, JSON.stringify({ tools: [...tools, { ...tools[0], name: 'fixture_added' }] }));
  await until(async () => (await page.evaluate(() => globalThis.asteriumExtensions.mcpStatus())).some((status) => status.state === 'ready' && status.toolCount === 2), 'list_changed rediscovery');
  result.cases.dynamicCatalogRefresh = 'passed';
  // An actual window close runs Main's application disposer and must stop the managed server.
  await page.close(); await until(() => child.exitCode !== null || child.signalCode !== null, 'graceful app shutdown');
  await until(() => !alive(stdioPid), 'managed stdio shutdown');
  assert.ok(requests.some((request) => request.method === 'DELETE'));
  assert.ok(requests.every((request) => request.authenticated));
  assert.ok(!diagnostics.includes('fixture-stderr-private-token'));
  result.cases.applicationDisposalAndHttpSessionCleanup = 'passed';
  await close(); await launch();
  const afterRestart = await page.evaluate(async () => {
    const api = globalThis.asteriumExtensions;
    if ((await api.mcpStatus()).length) throw new Error('Restart must not launch configured extensions');
    let state = await api.get(); const outcomes = [];
    for (const entry of state.extensions) outcomes.push(await api.connectMcp({ id: entry.id, expectedGeneration: entry.generation }));
    state = await api.get(); const entry = state.extensions[0];
    await api.setTrust({ expectedVersion: state.version, id: entry.id, action: 'revoke' });
    return { outcomes, status: await api.mcpStatus() };
  });
  assert.ok(afterRestart.outcomes.every((status) => status.state === 'ready'));
  assert.ok(afterRestart.status.some((status) => status.state === 'closed'));
  result.cases.restartLazyReconnectAndRevocation = 'passed';
  const failure = await page.evaluate(async workspaceGrantId => {
    const api = globalThis.asteriumExtensions; let state = await api.get();
    state = await api.upsert({ expectedVersion: state.version, name: 'Failure fixture', enabled: true, configuration: { type: 'mcp_stdio', command: 'asterium-s3-missing-executable', args: [], workspaceGrantId } });
    const entry = state.extensions.at(-1);
    try { await api.connectMcp({ id: entry.id, expectedGeneration: entry.generation }); return 'unexpected-success'; }
    catch (error) { return error.message; }
  }, workspaceGrantId);
  assert.match(failure, /MCP_(?:TRANSPORT_CLOSED|CONNECTION_FAILED)/);
  result.cases.failedLaunchSanitized = 'passed';
  const ungranted = await page.evaluate(async () => {
    const api = globalThis.asteriumExtensions; let state = await api.get();
    state = await api.upsert({ expectedVersion: state.version, name: 'Ungrant fixture', enabled: true, configuration: { type: 'mcp_stdio', command: 'must-never-launch', args: [], cwd: 'K:\\typed-path-is-not-authority' } });
    const entry = state.extensions.at(-1);
    try { await api.connectMcp({ id: entry.id, expectedGeneration: entry.generation }); return 'unexpected-success'; } catch (error) { return error.message; }
  });
  assert.match(ungranted, /MCP_AUTHORIZED_WORKSPACE_REQUIRED/); result.cases.missingWorkspaceStopsBeforeLaunch = 'passed';
  const packagedHost = JSON.parse(execFileSync(path.join(path.dirname(executable), 'resources', 'sandbox', 'AsteriumSandboxHelper.exe'), ['--status'], { encoding: 'utf8', windowsHide: true }));
  if (packagedHost.elevated) {
    const guarded = await page.evaluate(async () => {
      await globalThis.asteriumGeneralSettings.update({ sandboxEnabled: true, sandboxAllowNetwork: false });
      const api = globalThis.asteriumExtensions, state = await api.get(); const entry = state.extensions.find(item => item.name === 'S3 stdio');
      let failure = ''; try { await api.connectMcp({ id: entry.id, expectedGeneration: entry.generation }); } catch (error) { failure = error.message; }
      const http = state.extensions.find(item => item.configuration.type === 'mcp_http');
      const httpStatus = await api.connectMcp({ id: http.id, expectedGeneration: http.generation });
      const statuses = await api.mcpStatus();
      await globalThis.asteriumGeneralSettings.update({ sandboxEnabled: false });
      return { failure, httpStatus, local: statuses.find(item => item.extensionId === entry.id) };
    });
    assert.match(guarded.failure, /SANDBOX_ELEVATED_HOST_REFUSED/);
    assert.equal(guarded.local.sandboxed, false); assert.equal(guarded.httpStatus.backend, 'native'); assert.equal(guarded.httpStatus.state, 'ready');
    await assert.rejects(lstat(path.join(userData, 'sandbox-state')), error => error.code === 'ENOENT');
    result.cases.packagedEmptySandboxFailsClosed = 'passed'; result.cases.sandboxToggleDoesNotChangeHttp = 'passed';
  } else result.cases.packagedEmptySandboxFailsClosed = 'not_applicable_non_elevated';
  events = await lifecycle();
  assert.ok(events.filter((event) => event.event === 'request').every((event) => ['initialize', 'notifications/initialized', 'tools/list', 'notifications/cancelled'].includes(event.method)));
  assert.ok(requests.every((request) => request.rpc !== 'tools/call'));
} finally {
  await close(); await new Promise((resolve) => { http.closeAllConnections(); http.close(resolve); });
  const events = await lifecycle();
  await until(() => events.filter((event) => event.event === 'start').every((event) => !alive(event.pid)), 'all fixture processes exited');
  const target = await realpath(userData); const temp = await realpath(os.tmpdir());
  assert.equal(path.dirname(target).toLowerCase(), temp.toLowerCase()); assert.ok(path.basename(target).startsWith('asterium-s3-mcp-'));
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const workspaceTarget = await realpath(workspace);
  assert.equal(path.dirname(workspaceTarget).toLowerCase(), temp.toLowerCase()); assert.ok(path.basename(workspaceTarget).startsWith('asterium-s2-mcp-workspace-'));
  await rm(workspaceTarget, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
result.temporaryDataRemoved = true;
await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));

async function launch() {
  const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); launchFailure = undefined;
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: path.dirname(executable), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.once('error', (error) => { launchFailure = error; }); child.stderr.on('data', (bytes) => { diagnostics = `${diagnostics}${bytes}`.slice(-12_000); });
  await until(async () => {
    if (launchFailure) throw launchFailure; if (child.exitCode !== null) throw new Error('Isolated app exited during startup');
    return fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok).catch(() => false);
  }, 'debugger');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await until(() => { page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:')); return Boolean(page); }, 'page');
  await page.getByLabel('主要页面').waitFor();
}
async function close() {
  // Prefer the real application disposer; force only a failing/hung smoke process.
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { await until(() => child.exitCode !== null || child.signalCode !== null, 'application exit', 8_000); }
    catch {
      if (process.platform === 'win32') await new Promise((resolve) => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('exit', resolve); killer.once('error', resolve);
      }); else child.kill('SIGTERM');
    }
  }
  await browser?.close().catch(() => {}); browser = undefined; page = undefined; child = undefined;
}
async function lifecycle() { return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(probe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${label}`);
}
