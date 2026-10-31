import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceGrantStore } from '../../security/WorkspaceGrantStore';
import { assertCanonicalPathOutsideProtectedRoots } from '../../security/ProtectedPathPolicy';
import type { ExecutionWorkspace } from '../../execution/ExecutionContext';
import type { McpConfiguration } from './ExtensionLaunchBackend';

/** A path typed in configuration is not a user directory grant. */
export class McpManagementWorkspace {
  constructor(private readonly grants: WorkspaceGrantStore, private readonly protectedRoots: readonly string[]) {}
  async resolve(configuration: Extract<McpConfiguration, { type: 'mcp_stdio' }>): Promise<ExecutionWorkspace> {
    if (!configuration.workspaceGrantId) throw new Error('MCP_AUTHORIZED_WORKSPACE_REQUIRED');
    const granted = await this.grants.get(configuration.workspaceGrantId);
    if (!granted) throw new Error('MCP_AUTHORIZED_WORKSPACE_UNAVAILABLE');
    const root = await realpath(granted), cwd = await realpath(configuration.cwd ?? root);
    await assertCanonicalPathOutsideProtectedRoots(root, this.protectedRoots);
    await assertCanonicalPathOutsideProtectedRoots(cwd, this.protectedRoots);
    const relative = path.relative(root, cwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('MCP_CWD_OUTSIDE_AUTHORIZED_WORKSPACE');
    return { cwd, workspaceFolders: [root] };
  }
}
