// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionLaunchBackend, McpLaunchRequest, SkillScriptLaunchRequest } from '../../src/main/api/extensions/ExtensionLaunchBackend';
import { ExecutionGateway } from '../../src/main/execution/ExecutionGateway';

describe('single execution entry', () => {
  it('preserves request identity, handles and synchronous/asynchronous failure without fallback', async () => {
    const transport = {} as ReturnType<ExtensionLaunchBackend['createMcpTransport']>;
    const launched = {} as Awaited<ReturnType<ExtensionLaunchBackend['launchSkillScript']>>;
    const backend: ExtensionLaunchBackend = { id: 'sandbox', sandboxed: true,
      createMcpTransport: vi.fn(() => transport), launchSkillScript: vi.fn(async () => launched) };
    const entry = new ExecutionGateway(backend), signal = new AbortController().signal;
    const mcp: McpLaunchRequest = { configuration: { type: 'mcp_http', url: 'http://localhost/mcp' }, secrets: {}, signal };
    const skill: SkillScriptLaunchRequest = { command: 'node', args: ['script.js'], cwd: 'K:\\fixture', env: {}, signal };
    expect(entry.createMcpTransport(mcp)).toBe(transport);
    expect(await entry.launchSkillScript(skill)).toBe(launched);
    expect(vi.mocked(backend.createMcpTransport).mock.calls[0][0]).toBe(mcp);
    expect(vi.mocked(backend.launchSkillScript).mock.calls[0][0]).toBe(skill);
    expect(entry.id).toBe('sandbox'); expect(entry.sandboxed).toBe(true);
    const failure = new Error('selected backend unavailable');
    vi.mocked(backend.createMcpTransport).mockImplementation(() => { throw failure; });
    vi.mocked(backend.launchSkillScript).mockRejectedValue(failure);
    expect(() => entry.createMcpTransport(mcp)).toThrow(failure);
    await expect(entry.launchSkillScript(skill)).rejects.toBe(failure);
    expect(backend.createMcpTransport).toHaveBeenCalledTimes(2);
    expect(backend.launchSkillScript).toHaveBeenCalledTimes(2);
  });

  it('does not run a native command when the selected backend lacks command support', async () => {
    const backend: ExtensionLaunchBackend = { id: 'sandbox', sandboxed: true,
      createMcpTransport: vi.fn(), launchSkillScript: vi.fn() };
    await expect(new ExecutionGateway(backend).runCommand({ command: 'never-run', cwd: 'K:\\fixture', signal: new AbortController().signal }))
      .rejects.toThrow('EXECUTION_COMMAND_BACKEND_UNAVAILABLE');
    expect(backend.launchSkillScript).not.toHaveBeenCalled();
    expect(backend.createMcpTransport).not.toHaveBeenCalled();
  });

  it('preserves command requests, output and backend rejection without executing an alternate operation', async () => {
    const backend: ExtensionLaunchBackend = { id: 'sandbox', sandboxed: true,
      createMcpTransport: vi.fn(), launchSkillScript: vi.fn(), runCommand: vi.fn(async () => 'original\noutput') };
    const gateway = new ExecutionGateway(backend), request = { command: 'fixture', cwd: 'K:\\fixture', signal: new AbortController().signal };
    expect(await gateway.runCommand(request)).toBe('original\noutput');
    expect(vi.mocked(backend.runCommand!).mock.calls[0][0]).toBe(request);
    const failure = new Error('sandbox command unavailable'); vi.mocked(backend.runCommand!).mockRejectedValue(failure);
    await expect(gateway.runCommand(request)).rejects.toBe(failure);
    expect(backend.runCommand).toHaveBeenCalledTimes(2);
    expect(backend.launchSkillScript).not.toHaveBeenCalled(); expect(backend.createMcpTransport).not.toHaveBeenCalled();
  });
});
