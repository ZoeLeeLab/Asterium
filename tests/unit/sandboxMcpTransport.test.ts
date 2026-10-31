// @vitest-environment node
// Real SDK + custom transport, simulated helper IO. No physical isolation claim.
import { PassThrough } from 'node:stream';
import { realpath, stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SandboxMcpTransport, resolveSandboxExecutable } from '../../src/main/execution/SandboxMcpTransport';
import type { SandboxProcessRequest, SandboxResult, WindowsSandboxProcess } from '../../src/main/execution/WindowsSandboxProcess';
import type { McpLaunchRequest } from '../../src/main/api/extensions/ExtensionLaunchBackend';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath), stat: vi.fn(actual.stat) };
});
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const executableDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  Object.defineProperty(process, 'execPath', executableDescriptor);
  if (electronDescriptor) Object.defineProperty(process.versions, 'electron', electronDescriptor);
  else Reflect.deleteProperty(process.versions, 'electron');
  vi.resetAllMocks();
});
it('initializes, lists and repeatedly calls over one helper channel without a lifetime/output aggregate cutoff', async () => {
  const beforeStart = vi.fn(async () => undefined);
  const launch = vi.fn(async (request: SandboxProcessRequest) => {
    expect(request.timeoutMs).toBe(0); expect(request.outputLimitBytes).toBe(0); expect(request.environment).toEqual({ FIXTURE_TOKEN: 'synthetic-only' });
    await request.beforeStart!();
    const stdout = new PassThrough(), stderr = new PassThrough();
    let finish!: (value: unknown) => void; const completed = new Promise(resolve => { finish = resolve; });
    return { pid: 321, stdout, stderr, completed,
      send: async (bytes: Uint8Array) => {
        const message = JSON.parse(Buffer.from(bytes).toString()); if (message.id === undefined) return;
        const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'simulated-helper-server', version: '1' } }
          : message.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: message.params.arguments.value }] };
        queueMicrotask(() => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'));
      }, close: async () => { finish({ reason: 'cancelled', exitCode: 1, cleanup: 'confirmed' }); stdout.end(); stderr.end(); },
    };
  });
  const transport = new SandboxMcpTransport({ launch } as unknown as WindowsSandboxProcess, {
    context: { kind: 'user_management', purpose: 'mcp_probe', workspace: { cwd: process.cwd(), workspaceFolders: [process.cwd()] } },
    configuration: { type: 'mcp_stdio', command: process.execPath, args: [], cwd: process.cwd() }, secrets: { FIXTURE_TOKEN: 'synthetic-only' }, signal: new AbortController().signal,
    sandboxPolicy: { allowNetwork: false, policyKey: 'test' }, beforeStart,
  });
  const client = new Client({ name: 's2-test', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
  try {
    await client.connect(transport); expect((await client.listTools()).tools[0].name).toBe('echo');
    for (let i = 0; i < 5; i++) {
      const result = await client.callTool({ name: 'echo', arguments: { value: 'x'.repeat(20000) } });
      expect(JSON.stringify(result).length).toBeGreaterThan(20000);
    }
    expect(launch).toHaveBeenCalledOnce(); expect(beforeStart).toHaveBeenCalledOnce();
  } finally { await client.close(); }
});
it('refuses shell launchers rather than translating them to a Native spawn', async () => {
  await expect(resolveSandboxExecutable('npx.cmd')).rejects.toThrow('SANDBOX_LAUNCHER_NOT_SUPPORTED');
});

const bundledExecutable = 'C:\\Program Files\\Asterium\\Asterium.exe';
function runtime(platform: string, electron: boolean) {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  Object.defineProperty(process, 'execPath', { configurable: true, value: bundledExecutable });
  if (electron) Object.defineProperty(process.versions, 'electron', { configurable: true, value: '44.2.0' });
  else Reflect.deleteProperty(process.versions, 'electron');
  vi.mocked(realpath).mockImplementation(async filename => String(filename));
  vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
}
function launchFixture(command: string, secrets: Record<string, string>) {
  const request: McpLaunchRequest = {
    context: { kind: 'user_management', purpose: 'mcp_probe', workspace: { cwd: 'C:\\work', workspaceFolders: ['C:\\work'] } },
    configuration: { type: 'mcp_stdio', command, args: ['server.mjs', "literal ' 中文 $x", '--application-option'], cwd: 'C:\\work' },
    secrets, signal: new AbortController().signal, sandboxPolicy: { allowNetwork: false, policyKey: 'fixed' }, beforeStart: vi.fn(async () => undefined),
  };
  if (request.configuration.type === 'mcp_stdio') Object.freeze(request.configuration.args);
  Object.freeze(request.secrets);
  const launch = vi.fn(async (input: SandboxProcessRequest) => {
    await input.beforeStart!();
    const stdout = new PassThrough(), stderr = new PassThrough();
    let finish!: (value: SandboxResult) => void;
    const completed = new Promise<SandboxResult>(resolve => { finish = resolve; });
    return { pid: 321, stdout, stderr, completed, send: async () => undefined, close: async () => {
      finish({ type: 'result', reason: 'cancelled', exitCode: 1, cleanup: 'confirmed', started: true, profile: 'appcontainer', network: 'blocked' });
      stdout.end(); stderr.end();
    } };
  });
  return { request, launch, transport: new SandboxMcpTransport({ launch } as unknown as WindowsSandboxProcess, request) };
}

it.each([
  ['bundled Windows Electron', 'win32', true, bundledExecutable, '1', ['--no-stdio-init', '--preserve-symlinks-main']],
  ['external same-named executable', 'win32', true, 'D:\\external\\Asterium.exe', '1', ['--preserve-symlinks-main']],
  ['similar prefix sibling', 'win32', true, bundledExecutable + '.other.exe', '1', ['--preserve-symlinks-main']],
  ['ordinary Node even with the environment flag', 'win32', true, 'C:\\node\\node.exe', '1', ['--preserve-symlinks-main']],
  ['ordinary Node without the environment flag', 'win32', true, 'C:\\node\\node.exe', undefined, ['--preserve-symlinks-main']],
  ['Python executable', 'win32', true, 'C:\\python\\python.exe', undefined, []],
  ['environment flag alone in a Node host', 'win32', false, bundledExecutable, '1', ['--preserve-symlinks-main']],
  ['missing environment flag', 'win32', true, bundledExecutable, undefined, []],
  ['disabled environment flag', 'win32', true, bundledExecutable, '0', []],
  ['non-Windows host', 'linux', true, bundledExecutable, '1', ['--preserve-symlinks-main']],
] as const)('limits the stdio initialization prefix for %s', async (_name, platform, electron, command, flag, prefix) => {
  runtime(platform, electron);
  const secrets: Record<string, string> = { FIXTURE_TOKEN: 'synthetic-only', ...(flag === undefined ? {} : { ELECTRON_RUN_AS_NODE: flag }) };
  const f = launchFixture(command, secrets);
  try {
    await f.transport.start();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.launch.mock.calls[0][0]).toMatchObject({
      args: [...prefix, 'server.mjs', "literal ' 中文 $x", '--application-option'],
      environment: secrets, cwd: 'C:\\work', readOnlyRoots: [command.slice(0, command.lastIndexOf('\\'))],
      allowNetwork: false, timeoutMs: 0, outputLimitBytes: 0,
    });
    expect(f.request.configuration.type === 'mcp_stdio' && f.request.configuration.args).toEqual(['server.mjs', "literal ' 中文 $x", '--application-option']);
    expect(f.request.secrets).toEqual(secrets);
    expect(f.request.beforeStart).toHaveBeenCalledOnce();
    expect(f.transport.execution.sandboxed).toBe(true);
  } finally { await f.transport.close(); }
});

it('uses canonical paths and a case-insensitive Windows match for the bundled image', async () => {
  runtime('win32', true);
  vi.mocked(realpath).mockImplementation(async filename => String(filename) === bundledExecutable ? bundledExecutable.toLowerCase() : bundledExecutable);
  const f = launchFixture('C:\\bundle-alias\\Asterium.exe', { ELECTRON_RUN_AS_NODE: '1' });
  try {
    await f.transport.start();
    expect(f.launch.mock.calls[0][0].args.slice(0, 2)).toEqual(['--no-stdio-init', '--preserve-symlinks-main']);
    expect(f.launch.mock.calls[0][0].executable).toBe(bundledExecutable);
  } finally { await f.transport.close(); }
});

it('fails closed without launching when the bundled host path cannot be verified', async () => {
  runtime('win32', true);
  vi.mocked(realpath).mockImplementation(async filename => {
    if (String(filename) === bundledExecutable) throw Object.assign(new Error('fixture unavailable'), { code: 'ENOENT' });
    return bundledExecutable;
  });
  const f = launchFixture('C:\\bundle-alias\\Asterium.exe', { ELECTRON_RUN_AS_NODE: '1' });
  await expect(f.transport.start()).rejects.toThrow('fixture unavailable');
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.transport.execution.sandboxed).toBe(false);
  await f.transport.close();
});

it('does not retry or mark a failed helper launch as sandboxed', async () => {
  runtime('win32', true);
  const f = launchFixture(bundledExecutable, { ELECTRON_RUN_AS_NODE: '1' });
  f.launch.mockRejectedValue(new Error('SANDBOX_PROCESS_START_FAILED'));
  await expect(f.transport.start()).rejects.toThrow('SANDBOX_PROCESS_START_FAILED');
  await expect(f.transport.start()).rejects.toThrow('SANDBOX_MCP_ALREADY_STARTED_OR_CLOSED');
  expect(f.launch).toHaveBeenCalledOnce(); expect(f.transport.execution.sandboxed).toBe(false);
  await f.transport.close();
});
