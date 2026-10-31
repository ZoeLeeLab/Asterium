// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ExecutionBackendRouter } from '../../src/main/execution/ExecutionBackendRouter';
import type { ExecutionContext } from '../../src/main/execution/ExecutionContext';
import type { ExtensionLaunchBackend } from '../../src/main/api/extensions/ExtensionLaunchBackend';
const context = (mode = 'manual'): ExecutionContext => ({ kind: 'partner_runtime', partnerId: 'p', conversationId: 'c', policy: { permissionMode: mode as 'manual', planMode: 'default' } });
function fixture() {
  let settings = { sandboxEnabled: false, sandboxAllowNetwork: false };
  const native = { id: 'native', sandboxed: false, runCommand: vi.fn(async () => 'native'), createMcpTransport: vi.fn(() => ({})), launchSkillScript: vi.fn() } as unknown as ExtensionLaunchBackend;
  return { native, router: new ExecutionBackendRouter(async () => settings, undefined, native), set: (value: typeof settings) => { settings = value; } };
}
const request = { command: 'echo test', cwd: 'K:\\work', signal: new AbortController().signal };
it('preserves defaults and Full; an unavailable selected sandbox never runs Native', async () => {
  const f = fixture();
  await expect(f.router.runCommand({ ...request, context: context() })).resolves.toBe('native');
  f.set({ sandboxEnabled: true, sandboxAllowNetwork: true });
  await expect(f.router.runCommand({ ...request, context: context() })).rejects.toThrow('SANDBOX_BACKEND_UNAVAILABLE');
  await expect(f.router.runCommand({ ...request, context: context('full') })).resolves.toBe('native');
  expect(f.native.runCommand).toHaveBeenCalledTimes(2);
  await expect(f.router.runCommand({ ...request, context: context('read_only') })).rejects.toThrow('ASTERIUM_READ_ONLY');
  await expect(f.router.runCommand(request)).rejects.toThrow('SANDBOX_CONTEXT_REQUIRED');
});
it('HTTP bypasses local sandbox selection, while stdio does not', async () => {
  const f = fixture(); f.set({ sandboxEnabled: true, sandboxAllowNetwork: false });
  const base = { secrets: {}, signal: request.signal, context: context() };
  await f.router.createMcpTransport({ ...base, configuration: { type: 'mcp_http', url: 'https://example.com/' } });
  await expect(f.router.createMcpTransport({ ...base, configuration: { type: 'mcp_stdio', command: 'node', args: [] } })).rejects.toThrow('SANDBOX_BACKEND_UNAVAILABLE');
  expect(f.native.createMcpTransport).toHaveBeenCalledTimes(1);
});
it.each([[false, 'manual'], [true, 'full']] as const)('keeps Native stdio argv unchanged with sandbox=%s and mode=%s', async (enabled, mode) => {
  const f = fixture(); f.set({ sandboxEnabled: enabled, sandboxAllowNetwork: false });
  const args = ['server.mjs', "literal ' 中文 $x"];
  await f.router.createMcpTransport({ configuration: { type: 'mcp_stdio', command: 'C:\\Asterium\\Asterium.exe', args, cwd: 'C:\\work' },
    secrets: { ELECTRON_RUN_AS_NODE: '1' }, signal: request.signal, context: context(mode) });
  expect(f.native.createMcpTransport).toHaveBeenCalledOnce();
  expect(vi.mocked(f.native.createMcpTransport).mock.calls[0][0].configuration).toEqual({ type: 'mcp_stdio', command: 'C:\\Asterium\\Asterium.exe', args, cwd: 'C:\\work' });
  expect(args).not.toContain('--no-stdio-init');
});
it('invalidates pending selections and blocks launches while settings are draining', async () => {
  const f = fixture(); const pending = f.router.runCommand({ ...request, context: context() });
  const finish = await f.router.beginSettingsChange({ sandboxEnabled: false, sandboxAllowNetwork: false }, { sandboxEnabled: true, sandboxAllowNetwork: false }, async () => undefined);
  await expect(pending).rejects.toThrow('EXECUTION_SETTINGS_CHANGED');
  await expect(f.router.runCommand({ ...request, context: context() })).rejects.toThrow('EXECUTION_SETTINGS_CHANGING');
  await expect(f.router.runCommand({ ...request, context: context('full') })).resolves.toBe('native');
  finish();
});
it('waits for an affected Native operation to finish cancelling before a sandbox toggle is saved', async () => {
  const f = fixture();
  vi.mocked(f.native.runCommand!).mockImplementation(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
  const outcome = f.router.runCommand({ ...request, context: context() }).catch(error => error.message);
  await vi.waitFor(() => expect(f.native.runCommand).toHaveBeenCalledOnce());
  const finish = await f.router.beginSettingsChange({ sandboxEnabled: false, sandboxAllowNetwork: false }, { sandboxEnabled: true, sandboxAllowNetwork: false }, async () => undefined);
  expect(await outcome).toBe('cancelled'); finish();
});
it('a network setting stored while the sandbox is off never interrupts Native selection', async () => {
  const f = fixture(); const closeConnections = vi.fn(async () => undefined);
  const finish = await f.router.beginSettingsChange({ sandboxEnabled: false, sandboxAllowNetwork: false }, { sandboxEnabled: false, sandboxAllowNetwork: true }, closeConnections);
  await expect(f.router.runCommand({ ...request, context: context() })).resolves.toBe('native');
  expect(closeConnections).not.toHaveBeenCalled(); finish();
});
it('invalidates a suspended request on a workspace transition without holding the settings store', async () => {
  let start!: () => Promise<void>;
  const sandbox = { id: 'sandbox', sandboxed: true, runCommand: vi.fn(async (request: { beforeStart: () => Promise<void> }) => { start = request.beforeStart; return 'prepared'; }), createMcpTransport: vi.fn(), launchSkillScript: vi.fn() } as unknown as ExtensionLaunchBackend;
  const router = new ExecutionBackendRouter(async () => ({ sandboxEnabled: true, sandboxAllowNetwork: false }), sandbox);
  await router.runCommand({ ...request, context: context(), beforeStart: async () => undefined });
  await router.invalidatePartner('p', async () => undefined);
  await expect(start()).rejects.toThrow('SANDBOX_WORKSPACE_CHANGED');
});
