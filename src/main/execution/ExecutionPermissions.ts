import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ApiToolExecutionPolicy, PreparedApiTool } from '../api/ApiToolRegistry';
import { assertCanonicalPathOutsideProtectedRoots, textReferencesProtectedRoot } from '../security/ProtectedPathPolicy';

/** Descriptions are not grants. Native code can still perform unobservable IO. */
export interface ExecutionCapabilities {
  files?: { access: 'read' | 'write' | 'delete'; scope: 'workspace' | 'exact_file' | 'skill_package'; targets: string[] };
  workspace?: { action: 'list' | 'add' | 'remove'; target?: string };
  network?: { kind: 'public_https_read' | 'mcp_http' | 'native_unrestricted'; target?: string };
  process?: { kind: 'command' | 'skill_script' | 'mcp_stdio'; cwd?: string };
}
export interface WorkspaceAccessScope { primaryDirectory?: string; roots: readonly string[]; protectedRoots: readonly string[]; }

/** Stateless permission entry. Existing stores own grants, bindings and trust;
 * callers retain approval events and repeat guards at their original time boundaries.
 */
export const executionPermissions = {
  async checkTool(tool: PreparedApiTool, policy: ApiToolExecutionPolicy) {
    assertApiToolAllowed(tool, policy);
    await tool.guard?.(policy);
  },
  recheckTool(tool: PreparedApiTool, policy: ApiToolExecutionPolicy) { return tool.guard?.(policy); },
  requiresApproval(tool: PreparedApiTool, policy: ApiToolExecutionPolicy, externalWrite: boolean, trust?: string) {
    const required = apiToolRequiresAuthorization(tool, policy, externalWrite);
    if (tool.descriptor.purpose === 'command_native' && policy.permissionMode !== 'full') return true;
    return required && trust !== 'trusted';
  },
  extensionExecutionAllowed(policy: ApiToolExecutionPolicy) { return policy.planMode === 'default' && policy.permissionMode !== 'read_only'; },
  assertExtensionExecution(policy: ApiToolExecutionPolicy, code: string) {
    if (!executionPermissions.extensionExecutionAllowed(policy)) throw new Error(code);
  },
  extensionStartupRequiresApproval(policy: ApiToolExecutionPolicy, trust: string) { return policy.permissionMode !== 'full' && trust !== 'trusted'; },
  assertTrustApproval(policy: ApiToolExecutionPolicy) {
    executionPermissions.assertExtensionExecution(policy, 'API_EXTENSION_TRUST_POLICY_BLOCKED');
    if (policy.permissionMode !== 'manual' && policy.permissionMode !== 'automatic') throw new Error('API_EXTENSION_APPROVAL_NOT_REQUIRED');
  },
  assertCommandText(command: string, protectedRoots: readonly string[]) {
    if (textReferencesProtectedRoot(command, protectedRoots)) throw new Error('PROFILE_DATA_ACCESS_DENIED');
  },
  async resolveWorkspacePath(scope: WorkspaceAccessScope, input: string, mustExist: boolean) {
    if (!scope.primaryDirectory) throw new Error('API_WORKSPACE_NOT_CONFIGURED');
    const candidate = path.resolve(path.isAbsolute(input) ? input : path.join(scope.primaryDirectory, input));
    const resolved = mustExist ? await realpath(candidate) : await resolveFuturePath(candidate);
    await assertCanonicalPathOutsideProtectedRoots(resolved, scope.protectedRoots);
    const realRoots = await Promise.all(scope.roots.map((root) => realpath(root)));
    if (!realRoots.some((root) => containsPath(root, resolved))) throw new Error('TOOL_PATH_OUTSIDE_WORKSPACE');
    if (mustExist) await access(resolved);
    return resolved;
  },
  async externalWriteTarget(scope: WorkspaceAccessScope, input: string) {
    if (!scope.primaryDirectory) return undefined;
    const candidate = path.resolve(path.isAbsolute(input) ? input : path.join(scope.primaryDirectory, input));
    await assertCanonicalPathOutsideProtectedRoots(candidate, scope.protectedRoots);
    const realParent = await realpath(path.dirname(candidate));
    let target = path.join(realParent, path.basename(candidate));
    try {
      target = await realpath(target);
      if (!(await stat(target)).isFile()) throw new Error('TOOL_PATH_NOT_FILE');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error) || error.code !== 'ENOENT') throw error;
    }
    const realRoots = await Promise.all(scope.roots.map((root) => realpath(root)));
    return realRoots.some((root) => containsPath(root, target)) ? undefined : target;
  },
  async assertStructuredPaths(scope: WorkspaceAccessScope, value: unknown, field = '', depth = 0): Promise<void> {
    if (depth > 32) throw new Error('MCP_ARGUMENTS_TOO_DEEP');
    if (typeof value === 'string') {
      // Generic target/source/root/filename fields can be business IDs. Do not infer grants from them.
      const pathField = /^(?:path|paths|file_path|filepath|filepaths|directory|directories|cwd|source_path|destination_path|target_path|root_path)$/i.test(field);
      if (/^file:/i.test(value)) throw new Error('MCP_FILE_URI_NOT_SUPPORTED');
      if (pathField || path.win32.isAbsolute(value) || /^\.{1,2}[\\/]/.test(value)) {
        if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value)) throw new Error('MCP_ABSOLUTE_PATH_REQUIRED');
        await executionPermissions.resolveWorkspacePath(scope, value, false);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) await executionPermissions.assertStructuredPaths(scope, item, field, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) await executionPermissions.assertStructuredPaths(scope, item, key, depth + 1);
    }
  },
};

export function assertApiToolAllowed(tool: PreparedApiTool, policy: ApiToolExecutionPolicy) {
  if (policy.planMode === 'plan' && (!tool.allowInPlan || tool.descriptor.mutates)) throw new Error('ASTERIUM_PLAN_READ_ONLY');
  if (policy.permissionMode === 'read_only' && tool.descriptor.mutates) throw new Error('ASTERIUM_READ_ONLY');
}
export function apiToolRequiresAuthorization(tool: PreparedApiTool, policy: ApiToolExecutionPolicy, externalWrite = false) {
  assertApiToolAllowed(tool, policy);
  if (!tool.descriptor.mutates) return false;
  if (policy.permissionMode === 'manual') return true;
  if (policy.permissionMode === 'full') return false;
  if (externalWrite) return true;
  return policy.permissionMode === 'automatic' && tool.descriptor.action !== 'write_file';
}
async function resolveFuturePath(target: string): Promise<string> {
  let cursor = target;
  const tail: string[] = [];
  for (;;) {
    try { return path.join(await realpath(cursor), ...tail.reverse()); }
    catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error('TOOL_PATH_INVALID');
      tail.push(path.basename(cursor)); cursor = parent;
    }
  }
}
function containsPath(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
