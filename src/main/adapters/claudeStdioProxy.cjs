/* eslint-disable @typescript-eslint/no-require-imports -- standalone MCP stdio child. */
const net = require('node:net');
const readline = require('node:readline');

const pipe = process.env.ASTERIUM_CLAUDE_PIPE;
if (!pipe || !/^asterium-claude-[a-f0-9-]+$/i.test(pipe)) process.exit(2);
const socket = net.createConnection(`\\\\.\\pipe\\${pipe}`);
const pending = new Map();
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const inbound = readline.createInterface({ input: socket, crlfDelay: Infinity });
let sequence = 0;
function request(payload) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.write(`${JSON.stringify({ id, ...payload })}\n`, error => { if (error) { pending.delete(id); reject(error); } });
  });
}
inbound.on('line', line => {
  try {
    const item = JSON.parse(line); const waiter = pending.get(item.id);
    if (!waiter) return;
    pending.delete(item.id);
    if (item.error) waiter.reject(new Error(item.error)); else waiter.resolve(item.result);
  } catch { socket.destroy(new Error('INVALID_IPC_RESPONSE')); }
});
function stop() {
  for (const waiter of pending.values()) waiter.reject(new Error('CLAUDE_IPC_CLOSED'));
  pending.clear(); lines.close(); socket.destroy(); process.exitCode = 1;
}
socket.on('error', stop); socket.on('close', stop);
lines.on('line', async line => {
    let input; try { input = JSON.parse(line); } catch { return; }
    if (input.id === undefined) return;
    try {
      let result;
      if (input.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'asterium', version: '1.0.0' } };
      else if (input.method === 'ping') result = {};
      else if (input.method === 'tools/list') result = await request({ action: 'list' });
      else if (input.method === 'tools/call') result = await request({ action: 'call', name: input.params?.name, input: input.params?.arguments });
      else throw new Error('METHOD_NOT_FOUND');
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: input.id, result })}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: -32603, message: 'ASTERIUM_CLAUDE_BRIDGE_FAILED' } })}\n`);
    }
});
lines.on('close', () => { if (pending.size === 0) socket.end(); });
