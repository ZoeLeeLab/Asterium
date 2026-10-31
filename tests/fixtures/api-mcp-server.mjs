// Local protocol fixture. Tools only return synthetic data; no external access or private data.
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const [logPath, controlPath, mode = 'normal'] = process.argv.slice(2);
const log = (event) => fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
log({ event: 'start', cwd: process.cwd(), secretHash: createHash('sha256').update(process.env.FIXTURE_TOKEN ?? '').digest('hex'), inheritedCanary: Boolean(process.env.ASTERIUM_PRIVATE_CANARY) });
if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  log({ event: 'descendant', childPid: child.pid });
}
// This must never appear in Asterium logs or connection errors.
process.stderr.write('fixture-stderr-private-token\n');
let initialized = false;
let last = '';
const control = () => {
  try { return JSON.parse(fs.readFileSync(controlPath, 'utf8')); }
  catch { return { tools: [{ name: 'inspect', description: 'Fixture read', inputSchema: { type: 'object', properties: {} } }] }; }
};
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line); log({ event: 'request', method: request.method });
  if (request.method === 'initialize') {
    if (mode === 'hang') return;
    if (mode === 'crash') return process.exit(2);
    return send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'asterium-test', version: '1.0' } } });
  }
  if (request.method === 'notifications/initialized') { initialized = true; last = JSON.stringify(control()); return; }
  if (request.method === 'tools/list') {
    if (mode === 'hang-list') return;
    const current = control();
    if (mode === 'paginate' && !request.params?.cursor) return send({ id: request.id, result: { tools: current.tools.slice(0, 1), nextCursor: 'page-two' } });
    if (mode === 'paginate') return send({ id: request.id, result: { tools: current.tools.slice(1) } });
    if (mode === 'cycle') return send({ id: request.id, result: { tools: [], nextCursor: 'same-page' } });
    return send({ id: request.id, result: current });
  }
  if (request.method === 'tools/call') {
    log({ event: 'call', name: request.params.name, arguments: request.params.arguments });
    if (mode === 'hang-call') return;
    if (mode === 'rpc-error') return send({ id: request.id, error: { code: -32001, message: 'fixture-stderr-private-token' } });
    if (mode === 'bad-result') return send({ id: request.id, result: { content: 'invalid' } });
    const value = request.params.arguments.value ?? 'fixture';
    const result = { content: [{ type: 'text', text: mode === 'large-result' ? 'X'.repeat(600_000) : `fixture:${value}:${process.env.FIXTURE_TOKEN ?? ''}` }],
      structuredContent: { value: mode === 'bad-output' ? 42 : value }, ...(mode === 'tool-error' ? { isError: true } : {}) };
    if (mode === 'binary-result') result.content.push({ type: 'image', mimeType: 'image/png', data: 'c2VjcmV0' }, { type: 'resource_link', name: 'passive', uri: 'https://must-not-fetch.invalid' });
    if (mode === 'gated-call') {
      const release = () => control().releaseCall ? send({ id: request.id, result }) : setTimeout(release, 20);
      release();
      return;
    }
    return send({ id: request.id, result });
  }
  if (request.id !== undefined) send({ id: request.id, error: { code: -32601, message: 'fixture-stderr-private-token' } });
});
const watcher = setInterval(() => {
  if (!initialized) return;
  const next = JSON.stringify(control());
  if (next !== last) { last = next; send({ method: 'notifications/tools/list_changed' }); }
}, 40);
process.stdin.on('end', () => { clearInterval(watcher); process.exit(0); });
