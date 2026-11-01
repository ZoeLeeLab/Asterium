// Explicit local fixture acceptance: real official Windows CLI, synthetic model only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import Module from 'node:module';
import { build } from 'vite';

const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const cli = argument('--cli'), output = argument('--output');
if (process.platform !== 'win32' || !cli || !output || !path.isAbsolute(cli) || !path.isAbsolute(output)) throw new Error('Usage on Windows: node tests/claude-cli-acceptance.mjs --cli <official exe> --output <evidence directory>');
const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(output, { recursive: true });
const run = fs.mkdtempSync(path.join(output, 'claude-cli-'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const syntheticKey = 'asterium-synthetic-local-fixture';
const baseEnv = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const compiledResult = await build({ configFile: false, logLevel: 'error', build: { write: false, minify: false, lib: { entry: path.join(root, 'src/main/adapters/ClaudeCliTransport.ts'), formats: ['cjs'] }, rollupOptions: { external: ['electron', /^node:/] } } });
const compiledCode = (Array.isArray(compiledResult) ? compiledResult[0] : compiledResult).output.find(c => c.type === 'chunk').code;
const loaded = new Module(path.join(run, 'transport.cjs'), moduleForRequire());
loaded.filename = path.join(run, 'transport.cjs'); loaded.paths = Module._nodeModulePaths(root);
const requireOriginal = loaded.require.bind(loaded);
let activeChildren = [];
let activeFault;
loaded.require = name => name === 'electron' ? { app: { isPackaged: false } } : name === 'node:child_process' ? { ...cp, spawn: (...args) => {
  const settingsIndex = args[1].indexOf('--settings');
  if (activeFault && settingsIndex >= 0) {
    const file = args[1][settingsIndex + 1], settings = JSON.parse(fs.readFileSync(file));
    settings.disableAllHooks = false;
    const hook = activeFault === 'timeout' ? { command: 'powershell.exe', args: ['-NoProfile', '-Command', 'Start-Sleep -Seconds 5'], timeout: 1 } : activeFault === 'missing-executable' ? { command: path.join(path.dirname(file), 'missing-hook.exe'), args: [], timeout: 2 } : { command: 'powershell.exe', args: ['-NoProfile', '-File', path.join(path.dirname(file), 'missing-hook.ps1')], timeout: 2 };
    settings.hooks = { PreToolUse: [{ hooks: [{ type: 'command', onFailure: 'block', ...hook }] }] };
    fs.writeFileSync(file, JSON.stringify(settings));
  }
  const child = cp.spawn(...args), instance = { child, executable: args[0], arguments: args[1], diagnostics: '' };
  if (String(args[0]).endsWith('AsteriumClaudePipeHost.exe')) child.stdout.on('data', bytes => { instance.diagnostics += bytes; });
  activeChildren.push(instance); return child;
} } : requireOriginal(name);
loaded._compile(compiledCode, loaded.filename);
const transport = loaded.exports;
function moduleForRequire() { return new Module(import.meta.filename); }

function send(res, toolName, input) {
  const content = toolName ? { type: 'tool_use', id: `toolu_${crypto.randomUUID()}`, name: toolName, input: {} } : { type: 'text', text: '' };
  const events = [
    ['message_start', { type: 'message_start', message: { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: content }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: toolName ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: 'ASTERIUM_FIXTURE_COMPLETE' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: toolName ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }], ['message_stop', { type: 'message_stop' }],
  ];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(events.map(([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
}

async function testCase(spec) {
  const directory = path.join(run, spec.id), workspace = path.join(directory, 'workspace'), home = path.join(directory, 'home');
  for (const p of [workspace, home, path.join(home, '.claude'), path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(p, { recursive: true });
  const canary = path.join(workspace, 'fixture.txt'), target = path.join(workspace, 'result.txt');
  fs.writeFileSync(canary, 'ASTERIUM_SYNTHETIC_CANARY');
  const env = { ...baseEnv, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), TEMP: directory, TMP: directory, ANTHROPIC_API_KEY: syntheticKey, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', MCP_TIMEOUT: '5000' };
  const modelRequests = [], hostRequests = [], events = []; let statusCalls = 0, wrongProcessRejected = false;
  const toolName = spec.tool ?? 'Write';
  const toolInput = toolName === 'Read' ? { file_path: canary } : toolName === 'ExitPlanMode' ? { plan: 'Synthetic plan. No file changes.' } : toolName === 'Bash' ? { command: `echo ASTERIUM_SYNTHETIC > '${target.replaceAll('\\', '/')}'` } : toolName === 'PowerShell' ? { command: `[IO.File]::WriteAllText('${target.replaceAll("'", "''")}','ASTERIUM_SYNTHETIC')` } : toolName === 'AskUserQuestion' ? { questions: [{ question: 'Choose fixture', header: 'Fixture', options: [{ label: 'A', description: 'Synthetic A' }, { label: 'B', description: 'Synthetic B' }], multiSelect: false }] } : toolName.startsWith('mcp__') ? { key: 'time' } : { file_path: target, content: 'ASTERIUM_SYNTHETIC_WRITE' };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const bytes of req) { raw += bytes; if (raw.length > 4_000_000) throw new Error('Fixture input too large'); }
      const data = raw ? JSON.parse(raw) : {};
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":100}'); return; }
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
      assert.equal(req.headers['x-api-key'], syntheticKey);
      modelRequests.push({ messages: data.messages, toolNames: (data.tools ?? []).map(t => t.name) });
      const completed = (data.messages ?? []).some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
      send(res, completed ? undefined : toolName, toolInput);
    } catch { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"type":"error","error":{"type":"api_error","message":"Synthetic fixture rejected request"}}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const originalEnv = { ...process.env }; for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env);
  activeChildren = [];
  activeFault = spec.hookFault;
  const controller = new AbortController(); let timedOut = false, error;
  let timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
  const query = transport.query({ prompt: 'Run only the synthetic fixture request.', options: {
    cwd: workspace, pathToClaudeCodeExecutable: spec.missingExecutable ? path.join(directory, 'missing.exe') : cli,
    abortController: controller, settingSources: [], settings: { disableAllHooks: !spec.hooksActive }, strictMcpConfig: true,
    ...(spec.hooksActive ? { hooks: { PreToolUse: [{ hooks: [async () => ({ continue: true })] }] } } : {}),
    model: 'claude-sonnet-4-5', tools: ['Read', 'Write', 'Bash', 'PowerShell', 'AskUserQuestion', 'ExitPlanMode'], persistSession: false, maxTurns: 3,
    ...(spec.plan ? { permissionMode: 'plan' } : {}),
    mcpServers: { asterium: transport.createClaudeToolSet({ name: 'asterium', version: '1.0.0', tools: [transport.tool('fixture_status', 'Read synthetic status only.', {}, async () => { statusCalls++; return { content: [{ type: 'text', text: 'ASTERIUM_STATUS_FIXTURE' }] }; })] }) },
    canUseTool: async (name, input, context) => {
      hostRequests.push({ name, input, requestId: context.requestId, toolUseID: context.toolUseID });
      if (spec.wrongProcess) {
        const pipeName = activeChildren.find(c => String(c.executable).endsWith('AsteriumClaudePipeHost.exe'))?.arguments[0];
        const code = "const n=require('net');const s=n.createConnection('\\\\\\\\.\\\\pipe\\\\'+process.argv[1]);let got=false,connected=false;s.on('connect',()=>{connected=true;s.write(JSON.stringify({id:99,action:'call',name:'fixture_status',input:{}})+'\\n');});s.on('data',()=>got=true);s.on('error',()=>{});s.on('close',()=>{console.log(JSON.stringify({connected,received:got}));});setTimeout(()=>s.destroy(),1000);";
        const result = await new Promise((resolve, reject) => cp.execFile(process.execPath, ['-e', code, pipeName], { env, windowsHide: true, timeout: 3000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
        wrongProcessRejected = result.connected && !result.received && activeChildren.some(c => c.diagnostics.includes('CLAUDE_PIPE_WRONG_PROCESS_TREE'));
      }
      if (spec.disconnect) { activeChildren.find(c => String(c.executable).endsWith('AsteriumClaudePipeHost.exe'))?.child.kill(); await new Promise(resolve => setTimeout(resolve, 150)); return { behavior: 'allow', updatedInput: input }; }
      if (spec.cancel) { controller.abort(); await new Promise(resolve => setTimeout(resolve, 150)); return { behavior: 'allow', updatedInput: input }; }
      if (spec.timeout) {
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, 1500);
        return new Promise(() => {});
      }
      if (name === 'AskUserQuestion') return { behavior: 'allow', updatedInput: { ...input, answers: { 'Choose fixture': 'A' } } };
      return spec.allow || name === 'mcp__asterium__fixture_status' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'ASTERIUM_FIXTURE_DENIED' };
    },
  } });
  try { for await (const event of query) events.push(event); }
  catch (failure) { error = failure.message; }
  finally {
    clearTimeout(timer); query.close();
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, originalEnv);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  const results = modelRequests.flatMap(r => r.messages ?? []).filter(m => m.role === 'user').flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result');
  const result = { id: spec.id, hooksDisabled: !spec.hooksActive && !spec.hookFault, hookFault: spec.hookFault ?? null, timedOut, error: error ?? null, hostRequests: hostRequests.length, modelRequests: modelRequests.length, toolOffered: modelRequests.some(r => r.toolNames.includes(toolName)), canaryReturned: JSON.stringify(results).includes('ASTERIUM_SYNTHETIC_CANARY'), writeOccurred: fs.existsSync(target), statusCalls, wrongProcessRejected, questionAnswered: results.some(r => String(r.content).includes('"Choose fixture"="A"')), resultReceived: events.some(e => e.type === 'result'), assertions: [] };
  function check(condition, label) { result.assertions.push({ label, passed: Boolean(condition) }); }
  if (spec.missingExecutable) check(Boolean(error) && !result.writeOccurred, 'missing executable cannot perform a write');
  else {
    check(result.toolOffered, 'official CLI exposed the requested native/managed tool');
    check(result.hostRequests > 0 || spec.hookFault && results.some(r => r.is_error && /hook/i.test(JSON.stringify(r.content))), 'tool reached MCP host or the injected faulty hook already blocked it');
    if (toolName === 'Read') check(result.canaryReturned === Boolean(spec.allow), 'read content follows host decision');
    else if (toolName.startsWith('mcp__')) check(statusCalls === 1, 'managed tool ran exactly once in parent service');
    else if (toolName === 'AskUserQuestion') check(JSON.stringify(results).includes('Choose fixture') && JSON.stringify(results).includes('A'), 'question answer returned to official CLI');
    else if (toolName === 'ExitPlanMode') check(!result.writeOccurred && results.some(r => !r.is_error), 'native plan approval returned successfully without changing files');
    else check(result.writeOccurred === Boolean(spec.allow), 'write follows host decision, including late allows');
    if (spec.wrongProcess) check(wrongProcessRejected && statusCalls === 0, 'same-account client outside the bound CLI process tree cannot invoke a tool');
    if (spec.timeout) check(timedOut && !result.writeOccurred, 'expired approval never executed');
    if (!spec.disconnect && !spec.cancel && !spec.timeout) check(!timedOut && !error && result.resultReceived, 'turn completed without timeout or transport error');
  }
  result.passed = result.assertions.every(a => a.passed);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ result, hostRequests, modelRequests, events }, null, 2) + '\n');
  return result;
}

const version = cp.execFileSync(cli, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...baseEnv, DISABLE_AUTOUPDATER: '1' } }).trim();
const report = { version, cliSha256: hash(fs.readFileSync(cli)), platform: process.platform, architecture: process.arch, windowsRelease: os.release(), sourceCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), worktreeClean: !cp.execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), transportSha256: hash(compiledCode), realAccountUsed: false, realModelCalled: false, mcpTransport: 'stdio with current-user Windows IPC; HTTP is a synthetic model fixture only', cases: [] };
const missingScript = path.join(run, 'intentionally-missing-hook.ps1');
const exitProbe = cp.spawnSync('powershell.exe', ['-NoProfile', '-File', missingScript], { env: baseEnv, encoding: 'utf8', timeout: 10000, windowsHide: true });
report.windowsMissingScriptExit = { status: exitProbe.status, nonzeroObserved: exitProbe.status !== null && exitProbe.status !== 0 };
fs.writeFileSync(path.join(run, 'windows-exit-probe.txt'), String(exitProbe.stdout ?? '') + String(exitProbe.stderr ?? ''));
for (const spec of [
  { id: 'read-denied', tool: 'Read' }, { id: 'read-allowed', tool: 'Read', allow: true },
  { id: 'write-denied' }, { id: 'write-allowed', allow: true },
  { id: 'bash-denied', tool: 'Bash' }, { id: 'powershell-denied', tool: 'PowerShell' },
  { id: 'managed-tool', tool: 'mcp__asterium__fixture_status' }, { id: 'question', tool: 'AskUserQuestion' },
  { id: 'plan-approved', tool: 'ExitPlanMode', plan: true, allow: true },
  { id: 'approval-disconnected', disconnect: true }, { id: 'approval-cancelled', cancel: true },
  { id: 'approval-expired', timeout: true }, { id: 'wrong-process-tree', wrongProcess: true },
  { id: 'hooks-active-primary-deny', hooksActive: true },
  { id: 'hook-missing-script-primary-deny', hookFault: 'missing-script' },
  { id: 'hook-missing-executable-primary-deny', hookFault: 'missing-executable' },
  { id: 'hook-timeout-primary-deny', hookFault: 'timeout' },
  { id: 'missing-executable', missingExecutable: true },
]) { const result = await testCase(spec); report.cases.push(result); console.log(JSON.stringify(result)); }
report.failed = report.cases.filter(c => !c.passed).length;
fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ evidence: path.join(run, 'result.json'), cases: report.cases.length, failed: report.failed }));
if (report.failed) process.exitCode = 1;
