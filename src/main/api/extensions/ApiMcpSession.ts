import { createHash } from 'node:crypto';
import type { SendMessageCommand } from '../../../shared/agentProtocol';
import type { ApiExtensionSummary } from '../../../shared/apiExtensions';
import type { ApiAgentTools } from '../ApiAgentTools';
import { ApiExtensionStore } from '../ApiExtensionStore';
import type { ApiToolExecutionPolicy, ApiToolRegistration } from '../ApiToolRegistry';
import type { AsteriumRuntimeToolController } from '../../adapters/PartnerAdapter';
import { McpConnectionManager, type McpConnectionScope } from './McpConnectionManager';
import { compileMcpSchema } from './McpSchema';
import type { ExecutionContext, ExecutionWorkspace } from '../../execution/ExecutionContext';
import { executionPermissions } from '../../execution/ExecutionPermissions';

export interface McpStartupCandidate { entry: ApiExtensionSummary; approvalRequired: boolean; bindingRevision: number }
export class ApiMcpSession {
  private scope?: McpConnectionScope;
  private context = '';
  private readonly rejected = new Set<string>();
  private readonly connected = new Set<string>();
  private readonly reported = new Set<string>();
  private readonly notices: string[] = [];

  constructor(private readonly store: ApiExtensionStore, private readonly manager: McpConnectionManager,
    private readonly command: SendMessageCommand, private readonly runtimeTools: AsteriumRuntimeToolController,
    private readonly tools: ApiAgentTools,
  ) {}

  private allowed(policy: ApiToolExecutionPolicy) {
    return this.command.connectionSource === 'api_partner' && this.command.route?.scope !== 'workflow_planning'
      && executionPermissions.extensionExecutionAllowed(policy);
  }
  private assertMode(policy: ApiToolExecutionPolicy) {
    if (!this.allowed(policy)) throw new Error(policy.planMode === 'plan' ? 'ASTERIUM_PLAN_READ_ONLY' : 'ASTERIUM_READ_ONLY');
  }
  private async contextKey(policy: ApiToolExecutionPolicy) {
    return (await this.executionContext(policy)).contextKey!;
  }
  private async executionContext(policy: ApiToolExecutionPolicy): Promise<Extract<ExecutionContext, { kind: 'partner_runtime' }>> {
    const workspace = JSON.parse(await this.runtimeTools.status('workspace')) as ExecutionWorkspace;
    const contextKey = createHash('sha256').update(JSON.stringify({ route: this.command.route ?? { scope: 'single' }, workspace, policy })).digest('hex');
    return { kind: 'partner_runtime', partnerId: this.command.partnerId, conversationId: this.command.conversationId,
      route: this.command.route, workspace, policy, contextKey };
  }

  async candidates(policy: ApiToolExecutionPolicy): Promise<McpStartupCandidate[]> {
    if (!this.allowed(policy)) {
      this.tools.setExtensions([]);
      await this.manager.releaseOtherContexts({ kind: 'runtime', partnerId: this.command.partnerId, conversationId: this.command.conversationId, contextKey: 'blocked-mode' });
      return [];
    }
    const execution = await this.executionContext(policy), context = execution.contextKey!;
    if (context !== this.context) {
      if (this.scope) await this.manager.releaseScope(this.scope);
      this.context = context; this.connected.clear(); this.rejected.clear();
      this.scope = { kind: 'runtime', partnerId: this.command.partnerId, conversationId: this.command.conversationId, contextKey: context, execution };
      await this.manager.releaseOtherContexts(this.scope);
    }
    const entries = (await this.store.enabledForPartner(this.command.partnerId)).filter((entry) => entry.kind === 'mcp');
    const candidates: McpStartupCandidate[] = [];
    for (const entry of entries) {
      if (this.rejected.has(entry.id)) continue;
      try {
        const catalog = await this.manager.catalog(this.scope!, entry.id);
        if (catalog.generation === entry.generation) { this.connected.add(entry.id); continue; }
      } catch { /* Only configured, bound extensions can be offered for a new connection. */ }
      // A lost/changed connection needs a new turn, never automatic process restart/replay inside this run.
      if (this.connected.has(entry.id)) continue;
      const bindingRevision = await this.store.bindingRevision(this.command.partnerId, entry.id);
      if (bindingRevision === undefined) continue;
      candidates.push({ entry, bindingRevision, approvalRequired: executionPermissions.extensionStartupRequiresApproval(policy, entry.trust) });
    }
    return candidates;
  }

  async start(candidate: McpStartupCandidate, approved: boolean, policy: ApiToolExecutionPolicy, signal: AbortSignal) {
    this.assertMode(policy);
    if (!approved) { this.rejected.add(candidate.entry.id); return; }
    if (await this.contextKey(policy) !== this.context) throw new Error('MCP_CONTEXT_CHANGED');
    if (await this.store.bindingRevision(this.command.partnerId, candidate.entry.id) !== candidate.bindingRevision) throw new Error('API_EXTENSION_BINDING_CHANGED');
    await this.manager.connect(this.scope!, candidate.entry.id, candidate.entry.generation, signal, candidate.bindingRevision, async () => {
      signal.throwIfAborted();
      if (await this.contextKey(policy) !== this.context) throw new Error('MCP_CONTEXT_CHANGED');
    });
    this.connected.add(candidate.entry.id);
  }

  async registrations(policy: ApiToolExecutionPolicy): Promise<ApiToolRegistration[]> {
    if (!this.allowed(policy) || !this.scope) return [];
    const registrations: ApiToolRegistration[] = [];
    for (const entry of await this.store.enabledForPartner(this.command.partnerId)) {
      if (entry.kind !== 'mcp' || !this.connected.has(entry.id)) continue;
      try {
        const { tools, generation } = await this.manager.catalog(this.scope, entry.id);
        const secrets = Object.values(await this.store.connectionSecrets(entry.id, generation)).filter(Boolean).sort((a, b) => b.length - a.length);
        const redact = (value: string) => secrets.reduce((text, secret) => text.split(secret).join('[已隐藏凭据]'), value);
        const publicValue = (value: unknown): unknown => typeof value === 'string' ? redact(value)
          : Array.isArray(value) ? value.map(publicValue) : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([key, child]) => [redact(key), publicValue(child)])) : value;
        const serviceRegistrations: ApiToolRegistration[] = [];
        const expectedContext = this.context;
        for (const tool of tools) {
          const validate = compileMcpSchema(tool.inputSchema);
          if (tool.outputSchema) compileMcpSchema(tool.outputSchema);
          const scope = structuredClone(this.scope);
          const checkContext = async (args: Record<string, unknown>, currentPolicy: ApiToolExecutionPolicy) => {
            this.assertMode(currentPolicy);
            if (await this.contextKey(currentPolicy) !== expectedContext) throw new Error('MCP_CONTEXT_CHANGED');
            await this.tools.assertMcpPaths(args);
          };
          const guard = async (args: Record<string, unknown>, currentPolicy: ApiToolExecutionPolicy) => {
            await checkContext(args, currentPolicy);
            const current = (await this.store.enabledForPartner(this.command.partnerId)).find((item) => item.id === entry.id);
            if (!current || current.generation !== generation) throw new Error('MCP_AUTHORITY_CHANGED');
            if ((await this.manager.catalog(scope, entry.id)).generation !== generation) throw new Error('MCP_CATALOG_CHANGED');
          };
          serviceRegistrations.push({
            definition: { name: `mcp_${digest(entry.id)}_${digest(tool.name)}`, description: redact(`[MCP ${entry.name} / ${tool.name}] 文件路径必须使用已授权工作区内的绝对路径。${tool.description ?? ''}`).slice(0, 4_000), parameters: publicValue(tool.inputSchema) as Record<string, unknown> },
            presentationName: `mcp__${digest(entry.id)}__${redact(tool.name).slice(0, 400)}`,
            source: 'mcp', allowInPlan: false,
            argumentsValidator: (args) => { validate(args); return structuredClone(args); }, guard,
            describe: (args) => ({ mutates: true, action: 'external_side_effect', risk: 'high', summary: redact(`MCP「${entry.name}」请求调用 ${tool.name}。`), targets: [redact(`MCP 服务：${entry.name}；工具：${tool.name}`), `参数：${JSON.stringify(publicValue(args)).slice(0, 2_000)}`], capabilities: entry.configuration.type === 'mcp_http'
              ? { network: { kind: 'mcp_http', target: entry.configuration.url } }
              : { process: { kind: 'mcp_stdio', cwd: entry.configuration.type === 'mcp_stdio' ? entry.configuration.cwd : undefined }, network: { kind: 'native_unrestricted' } } }),
            extensionTrust: {
              extensionId: entry.id, name: redact(entry.name), generation,
              state: async (currentPolicy) => { await guard({}, currentPolicy); return (await this.store.enabledForPartner(this.command.partnerId)).find((item) => item.id === entry.id)!.trust; },
              prepare: async (currentPolicy) => { await guard({}, currentPolicy); return this.store.prepareTrustApproval(entry.id, currentPolicy, this.command.partnerId); },
              confirm: async (token, currentPolicy, signal) => {
                signal.throwIfAborted(); await guard({}, currentPolicy);
                await this.store.confirmTrustApproval(token, currentPolicy, this.command.partnerId, async () => { await checkContext({}, currentPolicy); signal.throwIfAborted(); });
              },
              discard: (token) => this.store.discardTrustApproval(token),
            },
            execute: async (args, signal, authorization) => {
              const currentPolicy = authorization.policy ?? policy;
              await guard(args, currentPolicy);
              const result = await this.manager.invoke(scope, entry.id, generation, tool.name, args, signal, () => checkContext(args, currentPolicy));
              // Binary blocks and resource links are passive metadata; never read/fetch/register artifacts automatically.
              const content = JSON.stringify(publicValue({ content: result.content.map((block) => block.type === 'text' ? { type: 'text', text: block.text }
                : block.type === 'resource' && 'text' in block.resource ? { type: 'resource', text: block.resource.text }
                : { type: block.type, omitted: true }), structuredContent: result.structuredContent, isError: Boolean(result.isError) }));
              const safe = content;
              return { content: safe.length > 64 * 1024 ? `${safe.slice(0, 64 * 1024)}\n[MCP_RESULT_TRUNCATED]` : safe, isError: Boolean(result.isError), execution: this.manager.localExecution(scope, entry.id) };
            },
          });
        }
        registrations.push(...serviceRegistrations);
      } catch {
        const key = `${entry.id}:${entry.generation}`;
        if (!this.reported.has(key)) {
          this.reported.add(key);
          this.notices.push(`MCP「${entry.name}」的工具目录暂不可用或含不支持的 schema，本轮暂不提供该服务的工具。`);
        }
      }
    }
    return registrations;
  }

  async cancel() { if (this.scope) await this.manager.releaseScope(this.scope); }
  takeNotices() { return this.notices.splice(0); }
}
function digest(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 16); }
