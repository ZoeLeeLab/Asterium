import type { ApiPartnerConnection, AttachmentCapabilities, SendMessageCommand } from '../../shared/agentProtocol';
import { AdapterHost } from '../AdapterHost';
import { ApiAgentSessionStore } from '../api/ApiAgentSessionStore';
import { ApiAgentTools } from '../api/ApiAgentTools';
import type { ApiExtensionStore } from '../api/ApiExtensionStore';
import type { McpConnectionManager } from '../api/extensions/McpConnectionManager';
import { ApiMcpSession } from '../api/extensions/ApiMcpSession';
import { ApiMcpInstaller } from '../api/extensions/ApiMcpInstaller';
import { ApiSkillSession } from '../api/extensions/ApiSkillSession';
import { SkillPackageLoader } from '../api/extensions/SkillPackageLoader';
import type { ExtensionLaunchBackend } from '../api/extensions/ExtensionLaunchBackend';
import { SkillScriptRunner } from '../api/extensions/SkillScriptRunner';
import { executionGatewayFor, nativeExecutionGateway } from '../execution/ExecutionGateway';
import type { ApiProviderRegistry } from '../api/ApiProviderRegistry';
import { ApiWebTools } from '../api/ApiWebTools';
import { ApiPartnerAdapter } from '../adapters/ApiPartnerAdapter';
import { ClaudeCodeAdapter } from '../adapters/ClaudeCodeAdapter';
import { CodexCliAdapter } from '../adapters/CodexCliAdapter';
import { CyberBossBridgeClient } from '../adapters/CyberBossBridgeClient';
import { ExistingThreadAdapter } from '../adapters/ExistingThreadAdapter';
import type { AsteriumRuntimeToolController } from '../adapters/PartnerAdapter';
import type { BridgeCursorStore } from '../security/BridgeCursorStore';
import type { ConversationAttachmentStore } from '../security/ConversationAttachmentStore';
import type { CredentialStore } from '../security/CredentialStore';

export interface ApiRuntimeRequest {
  command: SendMessageCommand;
  provider: ApiPartnerConnection['provider'];
  endpoint: string;
  model: string;
  apiKey: string;
  bindingKey?: string;
  toolsEnabled?: boolean;
  requestSettings?: ApiPartnerConnection['requestSettings'];
  modelSettings?: ApiPartnerConnection['modelSettings'];
  headers?: Record<string, string>;
  thinkingMode: 'auto' | 'enabled' | 'disabled';
  reasoningEffort: 'low' | 'high' | 'max';
  primaryDirectory?: string;
  additionalDirectories: string[];
  attachmentCapabilities: AttachmentCapabilities;
  runtimeTools: AsteriumRuntimeToolController;
}

export interface ExistingThreadRuntimeRequest {
  partnerId: string;
  credentialRef: string;
  serviceUrl: string;
  threadId: string;
}

export interface LocalRuntimeRequest {
  adapterType: 'claude_code' | 'codex_cli';
  adapterKey: string;
  executablePath: string;
  partnerRoot: string;
  additionalDirectories: string[];
  runtimeTools?: AsteriumRuntimeToolController;
}

export interface PartnerRuntimeFactoryOptions {
  host: AdapterHost;
  credentials: CredentialStore;
  bridgeCursors: BridgeCursorStore;
  apiSessions: ApiAgentSessionStore;
  attachments: ConversationAttachmentStore;
  braveApiKey: () => Promise<string | undefined>;
  protectedRoots: string[];
  apiProviders: ApiProviderRegistry;
  apiExtensions?: ApiExtensionStore;
  mcpConnections?: McpConnectionManager;
  extensionLaunchBackend?: ExtensionLaunchBackend;
}

export class PartnerRuntimeFactory {
  constructor(private readonly options: PartnerRuntimeFactoryOptions) {}

  createApi(request: ApiRuntimeRequest) {
    const providerDefinition = this.options.apiProviders.require(request.provider);
    const attachmentReader = {
      conversationId: request.command.conversationId,
      pathFor: (attachmentId: string, conversationId: string) => this.options.attachments.pathFor(attachmentId, conversationId),
      inspect: (attachmentId: string, conversationId: string) => this.options.attachments.inspect(attachmentId, conversationId),
    };
    const tools = new ApiAgentTools(request.primaryDirectory, request.additionalDirectories, attachmentReader,
      request.runtimeTools, new ApiWebTools({ braveApiKey: this.options.braveApiKey }), this.options.protectedRoots,
      this.options.extensionLaunchBackend ? executionGatewayFor(this.options.extensionLaunchBackend) : nativeExecutionGateway, request.command);
    return new ApiPartnerAdapter({
      providerDefinition,
      endpoint: request.endpoint,
      model: request.model,
      apiKey: request.apiKey,
      bindingKey: request.bindingKey,
      toolsEnabled: request.toolsEnabled,
      requestSettings: request.requestSettings,
      modelSettings: request.modelSettings,
      headers: request.headers,
      thinkingMode: request.thinkingMode,
      reasoningEffort: request.reasoningEffort,
      sessionStore: this.options.apiSessions,
      tools,
      mcpInstaller: this.options.apiExtensions && this.options.mcpConnections ? new ApiMcpInstaller(this.options.apiExtensions,
        request.command, request.runtimeTools, tools, this.options.protectedRoots) : undefined,
      skillSession: this.options.apiExtensions ? new ApiSkillSession(this.options.apiExtensions,
        new SkillPackageLoader(this.options.apiExtensions, this.options.protectedRoots), request.command,
        this.options.extensionLaunchBackend ? { runner: new SkillScriptRunner(this.options.extensionLaunchBackend), runtimeTools: request.runtimeTools, tools, cwd: request.primaryDirectory } : undefined) : undefined,
      mcpSession: this.options.apiExtensions && this.options.mcpConnections
        ? new ApiMcpSession(this.options.apiExtensions, this.options.mcpConnections, request.command, request.runtimeTools, tools) : undefined,
      attachmentReader,
      attachmentCapabilities: request.attachmentCapabilities,
    });
  }

  async getExisting(request: ExistingThreadRuntimeRequest, onReply?: ConstructorParameters<typeof ExistingThreadAdapter>[2]) {
    const adapterKey = `existing_thread:${request.partnerId}:${request.credentialRef}:${request.threadId}`;
    let adapter = this.options.host.get(adapterKey);
    if (adapter) return adapter;
    const secret = await this.options.credentials.get(request.credentialRef);
    if (!secret) throw new Error('CYBERBOSS_CREDENTIAL_REQUIRED');
    const cursorKey = `${request.partnerId}:messages`;
    const client = new CyberBossBridgeClient({
      serviceUrl: request.serviceUrl,
      secret,
      initialLastEventId: await this.options.bridgeCursors.get(cursorKey),
      onLastEventId: (eventId) => { void this.options.bridgeCursors.set(cursorKey, eventId); },
    });
    adapter = new ExistingThreadAdapter(client, request.threadId, onReply);
    return this.options.host.set(adapterKey, adapter);
  }

  getLocal(request: LocalRuntimeRequest) {
    let adapter = this.options.host.get(request.adapterKey);
    if (adapter) {
      if (request.runtimeTools) adapter.replaceRuntimeTools?.(request.runtimeTools);
      adapter.replaceRuntimeWorkspaceRoots?.(request.additionalDirectories);
      return adapter;
    }
    const resolveAttachment = (attachmentId: string, conversationId: string) => this.options.attachments.pathFor(attachmentId, conversationId);
    adapter = request.adapterType === 'codex_cli'
      ? new CodexCliAdapter(request.executablePath, request.partnerRoot, undefined, request.additionalDirectories, resolveAttachment, request.runtimeTools, this.options.protectedRoots)
      : new ClaudeCodeAdapter(request.executablePath, request.partnerRoot, undefined, undefined, request.additionalDirectories, resolveAttachment, request.runtimeTools, this.options.protectedRoots);
    return this.options.host.set(request.adapterKey, adapter);
  }
}

export function localRuntimeAdapterKey(input: {
  adapterType: LocalRuntimeRequest['adapterType'];
  runtimeId?: string;
  partnerId: string;
  conversationId: string;
  partnerRoot: string;
  additionalDirectories: string[];
}) {
  const stableIdentity = `${input.adapterType}:${input.runtimeId ?? ''}:${input.partnerId}:${input.conversationId}:${input.partnerRoot}`;
  // A Codex app-server owns the native thread writer. Project membership may
  // change extra roots between turns, so those roots must update in place
  // instead of selecting a second app-server for the same conversation.
  return input.adapterType === 'codex_cli'
    ? stableIdentity
    : `${stableIdentity}:${input.additionalDirectories.slice().sort().join(',')}`;
}
