import { ApiAgentRuntime } from '../api/ApiAgentRuntime';
import type { ApiMcpSession } from '../api/extensions/ApiMcpSession';
import type { ApiSkillSession } from '../api/extensions/ApiSkillSession';
import type { ApiMcpInstaller } from '../api/extensions/ApiMcpInstaller';
import type { ApiAgentSessionStore } from '../api/ApiAgentSessionStore';
import type { ApiAgentTools } from '../api/ApiAgentTools';
import type { ApiAttachmentReader } from '../api/ApiAgentTools';
import type { ApiPartnerConnection, AttachmentCapabilities } from '../../shared/agentProtocol';
import { createDefaultApiProviderRegistry, type ApiProviderDefinition } from '../api/ApiProviderRegistry';
import { apiBindingKey } from '../api/ApiConnectionStore';

type Fetcher = typeof fetch;

export interface ApiPartnerAdapterOptions {
  provider?: ApiPartnerConnection['provider'];
  providerDefinition?: ApiProviderDefinition;
  endpoint: string;
  model: string;
  apiKey: string;
  bindingKey?: string;
  toolsEnabled?: boolean;
  requestSettings?: ApiPartnerConnection['requestSettings'];
  modelSettings?: ApiPartnerConnection['modelSettings'];
  headers?: Record<string, string>;
  thinkingMode?: 'auto' | 'enabled' | 'disabled';
  reasoningEffort?: 'low' | 'high' | 'max';
  sessionStore?: ApiAgentSessionStore;
  tools?: ApiAgentTools;
  attachmentReader?: ApiAttachmentReader;
  attachmentCapabilities?: AttachmentCapabilities;
  fetcher?: Fetcher;
  mcpSession?: ApiMcpSession;
  skillSession?: ApiSkillSession;
  mcpInstaller?: ApiMcpInstaller;
}

/** Provider-compatible facade; orchestration lives in ApiAgentRuntime. */
export class ApiPartnerAdapter extends ApiAgentRuntime {
  constructor(options: ApiPartnerAdapterOptions) {
    const definition = options.providerDefinition ?? createDefaultApiProviderRegistry().require(options.provider ?? 'deepseek');
    const bindingKey = options.bindingKey ?? apiBindingKey(definition.id, options.endpoint, options.model);
    super({
      provider: definition.createAdapter({ ...options, bindingKey }),
      bindingKey,
      toolsEnabled: options.toolsEnabled,
      modelSettings: options.modelSettings,
      roundTimeoutMs: options.requestSettings?.roundTimeoutMs,
      providerRuntimePolicy: definition.runtimePolicy,
      sessionStore: options.sessionStore,
      tools: options.tools,
      mcpSession: options.mcpSession,
      skillSession: options.skillSession,
      mcpInstaller: options.mcpInstaller,
      attachmentReader: options.attachmentReader,
      attachmentCapabilities: options.attachmentCapabilities,
    });
  }
}
