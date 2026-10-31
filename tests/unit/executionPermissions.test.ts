// @vitest-environment node
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { ApiToolRegistry } from '../../src/main/api/ApiToolRegistry';
import { ApiWebTools } from '../../src/main/api/ApiWebTools';
import { executionPermissions } from '../../src/main/execution/ExecutionPermissions';

describe('execution permission boundaries', () => {
  it('describes read-only network independently of processes and keeps SSRF rejection before fetch', async () => {
    const runCommand = vi.fn(async () => 'must not execute');
    const fetcher = vi.fn(async () => new Response('<html><body>fixture page</body></html>', { headers: { 'content-type': 'text/html' } }));
    const web = new ApiWebTools({ fetcher, lookupHost: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }] as never) });
    const tools = new ApiAgentTools(undefined, [], undefined, undefined, web, [], { runCommand });
    const policy = { permissionMode: 'read_only', planMode: 'plan' } as const;
    const search = tools.prepare('web_search', { query: 'fixture' });
    expect(search.descriptor.capabilities).toEqual({ network: { kind: 'public_https_read' } });
    const publicPage = tools.prepare('web_fetch', { url: 'https://example.com/fixture' });
    expect(publicPage.descriptor.capabilities).toEqual({ network: { kind: 'public_https_read', target: 'https://example.com/fixture' } });
    await executionPermissions.checkTool(publicPage, policy);
    expect(executionPermissions.requiresApproval(publicPage, policy, false)).toBe(false);
    expect((await publicPage.execute(new AbortController().signal, { policy })).content).toContain('fixture page');
    const privatePage = tools.prepare('web_fetch', { url: 'https://127.0.0.1/private' });
    await executionPermissions.checkTool(privatePage, policy);
    await expect(privatePage.execute(new AbortController().signal, { policy })).rejects.toThrow('URL_REJECTED');
    expect(fetcher).toHaveBeenCalledOnce(); expect(runCommand).not.toHaveBeenCalled();
  });

  it('never treats capability descriptions or trust as authority to bypass mode restrictions', async () => {
    const guard = vi.fn(), execute = vi.fn();
    const registry = new ApiToolRegistry();
    registry.register({ definition: { name: 'effect', description: 'fixture', parameters: { type: 'object', properties: {} } }, source: 'mcp', allowInPlan: true, guard, execute,
      describe: () => ({ mutates: true, action: 'external_side_effect', risk: 'high', summary: 'fixture', targets: [], capabilities: { network: { kind: 'public_https_read' } } }) });
    const prepared = registry.prepare('effect', {});
    await expect(executionPermissions.checkTool(prepared, { permissionMode: 'full', planMode: 'plan' })).rejects.toThrow('ASTERIUM_PLAN_READ_ONLY');
    expect(() => executionPermissions.requiresApproval(prepared, { permissionMode: 'read_only', planMode: 'default' }, false, 'trusted')).toThrow('ASTERIUM_READ_ONLY');
    expect(guard).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it('carries the Main command identity and workspace without changing backend output', async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'asterium-permission-command-')));
    try {
      const runCommand = vi.fn(async () => 'original output');
      // Production supplies a full command. Structural typing must not leak its other fields.
      const owner = { partnerId: 'partner', conversationId: 'conversation', route: { scope: 'workspace' as const, projectId: 'project' }, content: { text: 'private prompt' }, apiContext: { history: ['private history'] } };
      const tools = new ApiAgentTools(directory, [], undefined, undefined, undefined, [], { runCommand }, owner);
      const policy = { permissionMode: 'manual', planMode: 'default' } as const;
      expect(await tools.execute('run_command', { command: 'fixture' }, new AbortController().signal, { policy })).toEqual({ content: 'original output' });
      expect(runCommand.mock.calls[0]).toEqual([expect.objectContaining({ cwd: directory, command: 'fixture', context: {
        kind: 'partner_runtime', partnerId: owner.partnerId, conversationId: owner.conversationId, route: owner.route,
        policy, workspace: { cwd: directory, workspaceFolders: [directory] },
      } })]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
