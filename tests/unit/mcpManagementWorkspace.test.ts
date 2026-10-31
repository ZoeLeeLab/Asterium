// @vitest-environment node
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceGrantStore } from '../../src/main/security/WorkspaceGrantStore';
import { McpManagementWorkspace } from '../../src/main/api/extensions/McpManagementWorkspace';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-mcp-workspace-')); roots.push(root);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace); await mkdir(path.join(workspace, 'sub'));
  const grants = new WorkspaceGrantStore(path.join(root, 'grants.json'));
  return { root, workspace, grants, authority: new McpManagementWorkspace(grants, []) };
}
it('a typed cwd cannot substitute for a user directory grant', async () => {
  const s = await fixture();
  await expect(s.authority.resolve({ type: 'mcp_stdio', command: 'node', args: [], cwd: s.workspace })).rejects.toThrow('MCP_AUTHORIZED_WORKSPACE_REQUIRED');
});
it('uses only the configured grant, checks cwd containment and observes revocation', async () => {
  const s = await fixture(); const grant = await s.grants.add(s.workspace);
  const config = { type: 'mcp_stdio' as const, command: 'node', args: [], workspaceGrantId: grant.grantId };
  expect(await s.authority.resolve(config)).toEqual({ cwd: await realpath(s.workspace), workspaceFolders: [await realpath(s.workspace)] });
  await expect(s.authority.resolve({ ...config, cwd: s.root })).rejects.toThrow('MCP_CWD_OUTSIDE_AUTHORIZED_WORKSPACE');
  await s.grants.deleteMany([grant.grantId]);
  await expect(s.authority.resolve(config)).rejects.toThrow('MCP_AUTHORIZED_WORKSPACE_UNAVAILABLE');
});
