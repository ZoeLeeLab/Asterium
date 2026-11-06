import { runAutoTest, spawnTestProcess as spawn, testRm as rm } from './helpers/autoTest.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

await runAutoTest(async () => {
// Optional native protocol/storage test. Never starts a model turn or uses real credentials.







const executable = process.env.ASTERIUM_CODEX_EXE;
if (!executable) throw new Error('Set ASTERIUM_CODEX_EXE to the native Codex executable under test.');
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'asterium-instruction-protocol-')));
const workspace = path.join(temporary, 'workspace'); const profile = path.join(temporary, 'codex-profile');
await mkdir(workspace); await mkdir(profile);
const args = ['-c', 'model_provider="asterium_fixture"', '-c', 'model="fixture-model"',
  '-c', 'model_providers.asterium_fixture={name="Offline fixture",base_url="http://127.0.0.1:1/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}',
  '-c', 'project_doc_max_bytes=0', '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', 'app-server', '--listen', 'stdio://'];
function launch() {
  const child = spawn(executable, args, { cwd: workspace, env: { ...process.env, CODEX_HOME: profile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout }); const pending = new Map(); let sequence = 0; let stderr = '';
  child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-4000); });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined || message.method) return;
    const work = pending.get(message.id); pending.delete(message.id); clearTimeout(work?.timer);
    if (message.error) work?.reject(new Error(JSON.stringify(message.error))); else work?.resolve(message.result);
  });
  return {
    request(method, params) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 15_000); pending.set(id, { resolve, reject, timer }); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); }); },
    notify(method) { child.stdin.write(`${JSON.stringify({ method })}\n`); },
    async close() { lines.close(); for (const work of pending.values()) { clearTimeout(work.timer); work.reject(new Error('Fixture closed')); } pending.clear(); if (child.exitCode !== null || child.signalCode !== null) return; await new Promise((resolve) => { const timer = setTimeout(() => child.kill(), 3000); child.once('close', () => { clearTimeout(timer); resolve(); }); child.stdin.end(); }); },
  };
}
async function initialize(client) { await client.request('initialize', { clientInfo: { name: 'asterium_instruction_fixture', version: '1' }, capabilities: { experimentalApi: true } }); client.notify('initialized'); }
async function records(file) {
  const began = Date.now();
  for (;;) {
    const data = await readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    if (data.includes('ASTERIUM_PERSONA_UPDATED_FIXTURE')) return data.trim().split('\n').map((line) => JSON.parse(line));
    if (Date.now() - began > 3000) throw new Error('Native instruction records did not flush');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
let client;
try {
  client = launch(); await initialize(client);
  const started = await client.request('thread/start', { cwd: workspace, developerInstructions: 'ASTERIUM_BOOTSTRAP_FIXTURE', dynamicTools: [{ name: 'asterium_status', description: 'Local test status.', inputSchema: { type: 'object', properties: {} } }] });
  const threadId = started.thread.id;
  assert(started.thread.path && path.resolve(started.thread.path).toLowerCase().startsWith(path.resolve(profile).toLowerCase() + path.sep), `Native fixture path check: ${JSON.stringify({ native: started.thread.path, profile })}`);
  await client.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'ASTERIUM_PERSONA_UPDATED_FIXTURE' }] }] });
  const persisted = await records(started.thread.path);
  const metadata = persisted.find((record) => record.type === 'session_meta').payload;
  assert(persisted.some((record) => record.type === 'response_item' && record.payload.role === 'developer' && record.payload.content.some((part) => part.text === 'ASTERIUM_BOOTSTRAP_FIXTURE')));
  assert(metadata.base_instructions && !JSON.stringify(metadata.base_instructions).includes('ASTERIUM_BOOTSTRAP_FIXTURE'), 'Native base instructions must not be replaced');
  assert(metadata.dynamic_tools.some((tool) => tool.name === 'asterium_status'));
  assert(persisted.some((record) => record.type === 'response_item' && record.payload.role === 'developer' && JSON.stringify(record.payload).includes('ASTERIUM_PERSONA_UPDATED_FIXTURE')));
  assert(!persisted.some((record) => record.type === 'response_item' && record.payload.role === 'user' && /ASTERIUM_(?:BOOTSTRAP|PERSONA)/u.test(JSON.stringify(record.payload))));
  await client.close(); client = launch(); await initialize(client);
  const resumed = await client.request('thread/resume', { threadId, cwd: workspace });
  assert.equal(resumed.thread.id, threadId);
  const restored = await records(started.thread.path);
  for (const token of ['ASTERIUM_BOOTSTRAP_FIXTURE', 'ASTERIUM_PERSONA_UPDATED_FIXTURE']) assert(restored.some((record) => record.type === 'response_item' && record.payload.role === 'developer' && JSON.stringify(record.payload).includes(token)));
  assert(restored.find((record) => record.type === 'session_meta').payload.dynamic_tools.some((tool) => tool.name === 'asterium_status'));
  const history = await client.request('thread/read', { threadId, includeTurns: true });
  assert(!history.thread.turns.flatMap((turn) => turn.items).some((item) => item.type === 'userMessage' && /ASTERIUM_(?:BOOTSTRAP|PERSONA)/u.test(JSON.stringify(item))));
  console.log('Native Codex protocol passed: developer bootstrap, persisted non-user persona update, restored thread, retained tools; no model turn or real user data.');
} finally {
  await client?.close();
  // Remove only the exact, mkdtemp-created fixture directory, never a user profile.
  await rm(temporary, { recursive: true, force: true });
}
});
