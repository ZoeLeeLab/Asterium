import { Client, isCallToolResult, type Tool, type Transport } from '@modelcontextprotocol/client';
import { assertMcpJsonBound, compileMcpSchema } from './McpSchema';
import { mcpConnectSchema, type ApiExtensionSummary, type McpConnectionStatus } from '../../../shared/apiExtensions';
import { ApiExtensionStore, type ApiExtensionChange } from '../ApiExtensionStore';
import type { ExecutionTransport, ExtensionLaunchBackend } from './ExtensionLaunchBackend';
import { executionGatewayFor, type ExecutionGateway } from '../../execution/ExecutionGateway';
import type { ExecutionContext, ExecutionWorkspace } from '../../execution/ExecutionContext';
import type { McpConfiguration } from './ExtensionLaunchBackend';
import path from 'node:path';

export type McpConnectionScope = { kind: 'management' } | {
  kind: 'runtime'; partnerId: string; conversationId: string;
  /** Main must change this when project/grants/working context changes. Never supplied by the model. */
  contextKey: string;
  execution?: Extract<ExecutionContext, { kind: 'partner_runtime' }>;
};
interface Connection {
  key: string; scope: McpConnectionScope; extensionId: string; generation: number; origin: symbol;
  bindingRevision?: number;
  state: McpConnectionStatus['state']; errorCode?: string;
  abort: AbortController; client?: Client; transport?: Transport; tools: Tool[];
  dirty: boolean; closing?: Promise<void>; operation?: Promise<McpConnectionStatus>;
  released?: boolean;
  local?: boolean;
  managementWorkspace?: ExecutionWorkspace;
}
export class McpConnectionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'McpConnectionError'; }
}

/** Main-owned, lazy connections; tools/call is available only through the authorized runtime registry. */
export class McpConnectionManager {
  private readonly connections = new Map<string, Connection>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private readonly backend: ExecutionGateway;

  constructor(private readonly store: ApiExtensionStore, backend: ExtensionLaunchBackend,
    private readonly timeoutMs = 15_000,
    private readonly managementWorkspace: (configuration: Extract<McpConfiguration, { type: 'mcp_stdio' }>) => Promise<ExecutionWorkspace> = async () => { throw new McpConnectionError('MCP_AUTHORIZED_WORKSPACE_REQUIRED'); },
  ) {
    if (backend.id === 'sandbox' && !backend.sandboxed) throw new McpConnectionError('MCP_BACKEND_INVALID');
    this.backend = executionGatewayFor(backend);
    this.unsubscribe = store.subscribe((change) => this.reconcile(change));
  }

  connectManagement(value: unknown, signal?: AbortSignal) {
    const input = mcpConnectSchema.parse(value);
    return this.connect({ kind: 'management' }, input.id, input.expectedGeneration, signal);
  }

  async connect(scope: McpConnectionScope, id: string, expectedGeneration: number, signal?: AbortSignal, expectedBindingRevision?: number, checkContext?: () => Promise<void>): Promise<McpConnectionStatus> {
    this.assertOpen();
    if (signal?.aborted) throw new McpConnectionError('MCP_CONNECTION_CANCELLED');
    const entry = await this.resolve(scope, id);
    let managementWorkspace: ExecutionWorkspace | undefined;
    if (scope.kind === 'management' && entry.configuration.type === 'mcp_stdio') {
      try { managementWorkspace = await this.managementWorkspace(entry.configuration); }
      catch (error) {
        const stale = this.connections.get(connectionKey(scope, id)); if (stale) await this.close(stale, 'MCP_WORKSPACE_CHANGED');
        throw new McpConnectionError(error instanceof Error && error.message.startsWith('MCP_') ? error.message : 'MCP_AUTHORIZED_WORKSPACE_UNAVAILABLE');
      }
    }
    this.assertOpen();
    if (entry.generation !== expectedGeneration) throw new McpConnectionError('MCP_STALE_CONFIGURATION');
    const bindingRevision = scope.kind === 'runtime' ? await this.store.bindingRevision(scope.partnerId, id) : undefined;
    if (scope.kind === 'runtime' && (bindingRevision === undefined || (expectedBindingRevision !== undefined && bindingRevision !== expectedBindingRevision))) throw new McpConnectionError('MCP_BINDING_CHANGED');
    if (signal?.aborted) throw new McpConnectionError('MCP_CONNECTION_CANCELLED');
    const key = connectionKey(scope, id);
    const existing = this.connections.get(key);
    if (existing && existing.generation === expectedGeneration && existing.bindingRevision === bindingRevision && !existing.closing) {
      if (existing.operation) return waitFor(existing.operation, signal);
      if (existing.state === 'ready') return this.status(existing);
    }
    if (existing) {
      await this.close(existing);
      if (!existing.released) throw new McpConnectionError('MCP_CLOSE_FAILED');
    }
    // Another caller may have completed replacement while the old close was awaited.
    const replacement = this.connections.get(key);
    if (replacement && replacement !== existing) return this.connect(scope, id, expectedGeneration, signal, expectedBindingRevision, checkContext);
    this.assertOpen();
    if (signal?.aborted) throw new McpConnectionError('MCP_CONNECTION_CANCELLED');
    if ([...this.connections.values()].filter((item) => !item.released).length >= 32) throw new McpConnectionError('MCP_CONNECTION_LIMIT');
    const connection: Connection = {
      key, scope: structuredClone(scope), extensionId: id, generation: expectedGeneration, bindingRevision, origin: Symbol(),
      state: 'connecting', abort: new AbortController(), tools: [], dirty: false,
      local: entry.configuration.type === 'mcp_stdio',
      managementWorkspace,
    };
    this.connections.set(key, connection);
    const cancel = () => connection.abort.abort(new McpConnectionError('MCP_CONNECTION_CANCELLED'));
    signal?.addEventListener('abort', cancel, { once: true });
    const operation = this.run(connection, async () => {
      const secrets = await this.store.connectionSecrets(id, connection.generation);
      await this.current(connection);
      const initialize = async () => {
        connection.abort.signal.throwIfAborted();
        if (entry.configuration.type === 'skill') throw new McpConnectionError('MCP_EXTENSION_REQUIRED');
        const configuration = entry.configuration.type === 'mcp_stdio' && managementWorkspace ? { ...entry.configuration, cwd: managementWorkspace.cwd } : entry.configuration;
        connection.transport = await this.backend.createMcpTransport({ configuration, secrets, signal: connection.abort.signal,
          context: executionContext(connection), beforeStart: async () => { await this.current(connection); await checkContext?.(); connection.abort.signal.throwIfAborted(); } });
        connection.abort.signal.throwIfAborted();
        // Legacy negotiation avoids SDK-owned sibling probes escaping the chosen launch backend.
        connection.client = new Client({ name: 'asterium-api-partner', version: '0.1.0' }, { versionNegotiation: { mode: 'legacy' } });
        connection.client.onclose = () => this.transportFailed(connection);
        connection.client.onerror = () => this.transportFailed(connection);
        connection.client.setNotificationHandler('notifications/tools/list_changed', () => this.catalogChanged(connection));
        return connection.client.connect(connection.transport, { signal: connection.abort.signal, timeout: this.timeoutMs });
      };
      if (scope.kind === 'runtime') {
        const { pending } = await this.store.dispatchForPartner(scope.partnerId, id, expectedGeneration, initialize, checkContext, bindingRevision);
        await pending;
      } else await initialize();
      await this.discover(connection);
    });
    connection.operation = operation;
    try { return await operation; }
    finally {
      signal?.removeEventListener('abort', cancel);
      this.finishOperation(connection, operation);
    }
  }

  managementStatus() { return [...this.connections.values()].filter((item) => item.scope.kind === 'management').map((item) => this.status(item)); }
  localExecution(scope: McpConnectionScope, id: string) {
    const connection = this.connections.get(connectionKey(scope, id));
    if (!connection?.local || connection.state !== 'ready') return undefined;
    const status = this.status(connection); return { backend: status.backend, sandboxed: status.sandboxed };
  }

  async disconnectManagement(id: string) {
    const connection = this.connections.get(connectionKey({ kind: 'management' }, id));
    if (connection) {
      await this.close(connection);
      if (!connection.released) throw new McpConnectionError('MCP_CLOSE_FAILED');
    }
  }

  /** S4 consumes a fresh ready snapshot, then still enforces permission/approval immediately before dispatch. */
  async catalog(scope: McpConnectionScope, id: string) {
    const connection = this.connections.get(connectionKey(scope, id));
    if (!connection || connection.state !== 'ready') throw new McpConnectionError('MCP_NOT_READY');
    try { await this.current(connection); } catch (error) { await this.close(connection, 'MCP_CONTEXT_CHANGED'); throw error; }
    if (connection.state !== 'ready') throw new McpConnectionError('MCP_NOT_READY');
    return { generation: connection.generation, tools: structuredClone(connection.tools) };
  }

  /** Main-only dispatch. The host registry must have enforced its mode, context and human approval first. */
  async invoke(scope: McpConnectionScope, id: string, generation: number, name: string, input: Record<string, unknown>, signal: AbortSignal, checkContext?: () => Promise<void>) {
    const connection = this.connections.get(connectionKey(scope, id));
    if (scope.kind !== 'runtime' || !connection || connection.state !== 'ready' || connection.generation !== generation) throw new McpConnectionError('MCP_NOT_READY');
    try { await this.current(connection); } catch (error) { await this.close(connection, 'MCP_CONTEXT_CHANGED'); throw error; }
    const tool = connection.tools.find((item) => item.name === name);
    if (!tool) throw new McpConnectionError('MCP_TOOL_UNAVAILABLE');
    const args = structuredClone(input);
    compileMcpSchema(tool.inputSchema)(args);
    const validateOutput = tool.outputSchema ? compileMcpSchema(tool.outputSchema) : undefined;
    const { pending } = await this.store.dispatchForPartner(scope.partnerId, id, generation, () => {
      signal.throwIfAborted(); connection.abort.signal.throwIfAborted();
      if (connection.state !== 'ready' || connection.generation !== generation) throw new McpConnectionError('MCP_NOT_READY');
      const context = executionContext(connection);
      if (context.kind !== 'partner_runtime') throw new McpConnectionError('MCP_NOT_READY');
      return this.backend.dispatchMcp({ context, dispatch: () => connection.client!.request({ method: 'tools/call', params: { name, arguments: args } }, {
        signal: AbortSignal.any([signal, connection.abort.signal]), timeout: 30_000,
      }) });
    }, checkContext, connection.bindingRevision);
    try {
      const result = await waitFor(pending, signal);
      if (!isCallToolResult(result)) throw new McpConnectionError('MCP_RESULT_INVALID');
      assertMcpJsonBound(result, 512 * 1024);
      if (!result.isError && validateOutput) validateOutput(result.structuredContent);
      return result;
    } catch (error) {
      if (signal.aborted) {
        if ((connection.transport as ExecutionTransport | undefined)?.execution?.sandboxed) {
          await this.close(connection, 'MCP_CALL_CANCELLED'); if (!connection.released) throw new McpConnectionError('MCP_CLOSE_FAILED');
        }
        throw new McpConnectionError('MCP_CALL_CANCELLED');
      }
      if (error instanceof McpConnectionError) throw error;
      throw new McpConnectionError('MCP_CALL_FAILED');
    }
  }

  async releaseScope(scope: McpConnectionScope) {
    const selected = [...this.connections.values()].filter((item) => connectionKey(item.scope, '') === connectionKey(scope, ''));
    await Promise.all(selected.map((item) => this.close(item)));
    for (const item of selected) if (item.released && this.connections.get(item.key) === item) this.connections.delete(item.key);
  }

  /** Per-turn adapters must not leave an older working context alive for the same conversation. */
  async releaseOtherContexts(scope: Extract<McpConnectionScope, { kind: 'runtime' }>) {
    const stale = [...this.connections.values()].filter((item) => item.scope.kind === 'runtime'
      && item.scope.partnerId === scope.partnerId && item.scope.conversationId === scope.conversationId && item.scope.contextKey !== scope.contextKey);
    await Promise.all(stale.map((item) => this.close(item, 'MCP_CONTEXT_CHANGED')));
  }

  async invalidatePartner(partnerId?: string) {
    await Promise.all([...this.connections.values()].filter((item) => item.scope.kind === 'runtime' && (!partnerId || item.scope.partnerId === partnerId)).map((item) => this.close(item)));
  }
  async invalidateLocalPartner(partnerId: string) {
    const affected = [...this.connections.values()].filter(item => item.local && item.scope.kind === 'runtime' && item.scope.partnerId === partnerId && !item.released);
    await Promise.all(affected.map(item => this.close(item, 'MCP_WORKSPACE_CHANGED')));
    if (affected.some(item => !item.released)) throw new McpConnectionError('MCP_CLOSE_FAILED');
  }
  async invalidateWorkspaceRoots(roots: readonly string[]) {
    const affected = [...this.connections.values()].filter(item => item.local && !item.released
      && (item.scope.kind === 'management' ? item.managementWorkspace : item.scope.execution?.workspace)?.workspaceFolders.some(folder => roots.some(root => path.resolve(folder).toLowerCase() === path.resolve(root).toLowerCase())));
    await Promise.all(affected.map(item => this.close(item, 'MCP_WORKSPACE_CHANGED')));
    if (affected.some(item => !item.released)) throw new McpConnectionError('MCP_CLOSE_FAILED');
  }

  async reconcilePartners(partnerId?: string) {
    await Promise.all([...this.connections.values()].filter((item) => item.scope.kind === 'runtime' && (!partnerId || item.scope.partnerId === partnerId)).map(async (item) => {
      try { await this.current(item); }
      catch { await this.close(item, 'MCP_CONFIGURATION_CHANGED'); }
    }));
  }

  async dispose() {
    this.disposed = true; this.unsubscribe();
    await Promise.all([...this.connections.values()].map((item) => this.close(item)));
    this.connections.clear();
  }

  async invalidateLocalExecution(networkOnly: boolean) {
    const affected = [...this.connections.values()].filter(item => item.local && !item.released
      && !(item.scope.kind === 'runtime' && item.scope.execution?.policy?.permissionMode === 'full')
      && (!networkOnly || (item.transport as ExecutionTransport | undefined)?.execution?.backend === 'sandbox'));
    await Promise.all(affected.map(item => this.close(item, 'MCP_EXECUTION_SETTINGS_CHANGED')));
    if (affected.some(item => !item.released)) throw new McpConnectionError('MCP_CLOSE_FAILED');
  }
  async revalidateManagementWorkspaces() {
    for (const connection of this.connections.values()) {
      if (connection.scope.kind !== 'management' || !connection.local || connection.released) continue;
      try { await this.current(connection); }
      catch { await this.close(connection, 'MCP_WORKSPACE_CHANGED'); }
    }
  }

  private async discover(connection: Connection) {
    for (let attempt = 0; attempt < 3; attempt++) {
      connection.dirty = false;
      const tools: Tool[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
      if (connection.client?.getServerCapabilities()?.tools) {
        for (let page = 0; ; page++) {
          if (page >= 16) throw new McpConnectionError('MCP_CATALOG_LIMIT');
          const result = await connection.client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, { signal: connection.abort.signal, timeout: this.timeoutMs });
          tools.push(...result.tools);
          if (tools.length > 256 || Buffer.byteLength(JSON.stringify(tools)) > 1024 * 1024) throw new McpConnectionError('MCP_CATALOG_LIMIT');
          cursor = result.nextCursor;
          if (!cursor) break;
          if (cursors.has(cursor)) throw new McpConnectionError('MCP_CATALOG_INVALID');
          cursors.add(cursor);
        }
      }
      const names = new Set<string>();
      for (const tool of tools) {
        if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || names.has(tool.name)) throw new McpConnectionError('MCP_CATALOG_INVALID');
        names.add(tool.name);
      }
      if (connection.dirty) continue;
      await this.current(connection);
      const recorded = await this.store.recordInventory(connection.extensionId, connection.generation, tools.slice().sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), connection.origin);
      connection.generation = recorded.generation;
      await this.current(connection);
      if (connection.dirty) continue;
      connection.abort.signal.throwIfAborted();
      connection.tools = structuredClone(tools); connection.state = 'ready'; return;
    }
    throw new McpConnectionError('MCP_CATALOG_UNSTABLE');
  }

  private catalogChanged(connection: Connection) {
    if (connection.closing) return;
    connection.dirty = true;
    if (connection.state === 'ready') { connection.state = 'refreshing'; connection.tools = []; }
    if (connection.operation) return;
    connection.state = 'refreshing'; connection.tools = [];
    const operation = this.run(connection, async () => {
      const entry = await this.store.invalidateInventory(connection.extensionId, connection.generation, connection.origin);
      connection.generation = entry.generation;
      await this.discover(connection);
    });
    connection.operation = operation;
    void operation.catch(() => undefined).finally(() => this.finishOperation(connection, operation));
  }

  private finishOperation(connection: Connection, operation: Promise<McpConnectionStatus>) {
    if (connection.operation !== operation) return;
    connection.operation = undefined;
    if (connection.dirty && !connection.closing) this.catalogChanged(connection);
  }

  private async run(connection: Connection, action: () => Promise<void>) {
    const timer = setTimeout(() => connection.abort.abort(new McpConnectionError('MCP_CONNECTION_TIMEOUT')), this.timeoutMs);
    try {
      await waitFor(action(), connection.abort.signal);
      connection.abort.signal.throwIfAborted();
      return this.status(connection);
    } catch (error) {
      const reason = connection.abort.signal.aborted ? connection.abort.signal.reason : error;
      const code = reason instanceof McpConnectionError ? reason.code : reason instanceof Error && /^SANDBOX_[A-Z_]+$/.test(reason.message) ? reason.message : 'MCP_CONNECTION_FAILED';
      await this.close(connection);
      if (connection.errorCode !== 'MCP_CLOSE_FAILED' && code !== 'MCP_CONNECTION_CANCELLED' && code !== 'MCP_CONFIGURATION_CHANGED') { connection.state = 'failed'; connection.errorCode = code; }
      throw new McpConnectionError(code);
    } finally { clearTimeout(timer); }
  }

  private reconcile({ snapshot, inventoryOrigin }: ApiExtensionChange) {
    for (const connection of this.connections.values()) {
      const entry = snapshot.extensions.find((item) => item.id === connection.extensionId);
      if (entry && inventoryOrigin === connection.origin) connection.generation = entry.generation;
      const scope = connection.scope;
      const unbound = scope.kind === 'runtime' && !snapshot.bindings.some((item) => item.partnerId === scope.partnerId && item.extensionIds.includes(connection.extensionId));
      if (!entry?.enabled || entry.generation !== connection.generation || unbound) void this.close(connection, 'MCP_CONFIGURATION_CHANGED');
    }
  }

  private async resolve(scope: McpConnectionScope, id: string): Promise<ApiExtensionSummary> {
    const entries = scope.kind === 'management' ? (await this.store.get()).extensions : await this.store.enabledForPartner(scope.partnerId);
    const entry = entries.find((item) => item.id === id && item.enabled && item.kind === 'mcp');
    if (!entry) throw new McpConnectionError('MCP_EXTENSION_UNAVAILABLE');
    return entry;
  }

  private async current(connection: Connection) {
    connection.abort.signal.throwIfAborted();
    const entry = await this.resolve(connection.scope, connection.extensionId);
    connection.abort.signal.throwIfAborted();
    if (entry.generation !== connection.generation) throw new McpConnectionError('MCP_STALE_CONFIGURATION');
    if (connection.scope.kind === 'management' && entry.configuration.type === 'mcp_stdio') {
      try {
        const workspace = await this.managementWorkspace(entry.configuration);
        if (JSON.stringify(workspace) !== JSON.stringify(connection.managementWorkspace)) throw new Error('changed');
      } catch { throw new McpConnectionError('MCP_AUTHORIZED_WORKSPACE_UNAVAILABLE'); }
    }
    if (connection.scope.kind === 'runtime' && await this.store.bindingRevision(connection.scope.partnerId, connection.extensionId) !== connection.bindingRevision) throw new McpConnectionError('MCP_BINDING_CHANGED');
  }

  private transportFailed(connection: Connection) {
    if (!connection.closing) {
      connection.state = 'failed'; connection.errorCode = 'MCP_TRANSPORT_CLOSED';
      void this.close(connection, 'MCP_TRANSPORT_CLOSED').then(() => {
        if (connection.errorCode !== 'MCP_CLOSE_FAILED') { connection.state = 'failed'; connection.errorCode = 'MCP_TRANSPORT_CLOSED'; }
      });
    }
  }

  private close(connection: Connection, code = 'MCP_CONNECTION_CANCELLED'): Promise<void> {
    if (connection.closing) return connection.closing;
    connection.state = 'closed'; connection.tools = [];
    connection.abort.abort(new McpConnectionError(code));
    connection.closing = Promise.resolve();
    connection.closing = (async () => {
      let failed = false;
      const cleanup = async () => {
        try { await connection.client?.close(); } catch { failed = true; }
        try { await connection.transport?.close(); } catch { failed = true; }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([cleanup(), new Promise<void>((resolve) => {
        timer = setTimeout(() => { failed = true; resolve(); }, Math.max(1_000, Math.min(5_000, this.timeoutMs)));
      })]);
      clearTimeout(timer);
      connection.released = !failed;
      if (failed) { connection.state = 'failed'; connection.errorCode = 'MCP_CLOSE_FAILED'; }
      if (!failed && connection.scope.kind === 'runtime' && this.connections.get(connection.key) === connection) this.connections.delete(connection.key);
    })();
    return connection.closing;
  }

  private assertOpen() { if (this.disposed) throw new McpConnectionError('MCP_MANAGER_DISPOSED'); }
  private status(connection: Connection): McpConnectionStatus {
    const execution = (connection.transport as ExecutionTransport | undefined)?.execution;
    return { extensionId: connection.extensionId, generation: connection.generation, state: connection.state, backend: execution?.backend ?? this.backend.id, sandboxed: execution?.sandboxed ?? (connection.transport ? this.backend.sandboxed : false), toolCount: connection.state === 'ready' ? connection.tools.length : 0, ...(connection.errorCode ? { errorCode: connection.errorCode } : {}) };
  }
}

function connectionKey(scope: McpConnectionScope, id: string) {
  return JSON.stringify([scope.kind, scope.kind === 'runtime' ? [scope.partnerId, scope.conversationId, scope.contextKey] : null, id]);
}
function executionContext(connection: Connection): ExecutionContext {
  const scope = connection.scope;
  // Management never inherits a runtime identity, policy, binding or trust.
  return scope.kind === 'management' ? { kind: 'user_management', purpose: 'mcp_probe', ...(connection.managementWorkspace ? { workspace: connection.managementWorkspace } : {}) } : {
    ...scope.execution, kind: 'partner_runtime', partnerId: scope.partnerId, conversationId: scope.conversationId,
    contextKey: scope.contextKey, extension: { id: connection.extensionId, generation: connection.generation, bindingRevision: connection.bindingRevision },
  };
}
function waitFor<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof McpConnectionError ? signal.reason : new McpConnectionError('MCP_CONNECTION_CANCELLED'));
    if (signal.aborted) { void operation.catch(() => undefined); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
