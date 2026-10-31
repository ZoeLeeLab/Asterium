/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS helper launched by Electron's Node runtime. */
const { stat } = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

(async () => {
  for await (const line of lines) {
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    if (request.method === 'initialize') {
      reply(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'asterium-delivery', version: '2.0.0' } });
      continue;
    }
    if (request.method === 'tools/list') {
      reply(request.id, { tools: [{ name: 'deliver_file', description: 'Register one completed file for delivery. In a project group chat, this explicit call formally delivers the file to that room\'s project; intermediate files are never delivered automatically. Always call this for final files created or updated by a terminal, shell, PowerShell, MCP tool, or outside the current workspace; do not guess whether Asterium detected the file automatically. This accepts one exact existing file only. Do not register ordinary reads, intermediate files, or directories.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' } }, required: ['path'], additionalProperties: false } }] });
      continue;
    }
    if (request.method === 'tools/call') {
      const params = asRecord(request.params);
      const args = asRecord(params.arguments);
      const filePath = typeof args.path === 'string' ? path.resolve(args.path) : '';
      const value = filePath ? await stat(filePath).catch(() => undefined) : undefined;
      if (!value?.isFile()) reply(request.id, { content: [{ type: 'text', text: '文件不存在或不是普通文件。' }], isError: true });
      else reply(request.id, { content: [{ type: 'text', text: `已登记交付：${typeof args.name === 'string' && args.name.trim() ? args.name.trim() : path.basename(filePath)}` }], structuredContent: { path: filePath }, isError: false });
      continue;
    }
    replyError(request.id, -32601, 'Method not found');
  }
})().catch(() => process.exitCode = 1);

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function replyError(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }
function asRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}; }
