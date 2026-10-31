import type { ApiRuntimeToolCall } from './ApiAgentSessionStore';
import type { AttachmentCapabilities, ProtocolError } from '../../shared/agentProtocol';

export type ApiProviderContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string };

export type ApiProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ApiProviderContentPart[] }
  | { role: 'assistant'; content: string; reasoningContent: string; toolCalls?: ApiRuntimeToolCall[]; native?: { binding: string; items: unknown[] } }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ApiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ApiProviderStreamEvent =
  | { type: 'native.state'; items: unknown[] }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'text.delta'; text: string }
  | { type: 'tool.delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { type: 'finish'; reason: string };

export interface ApiProviderRequest {
  messages: ApiProviderMessage[];
  tools: ApiToolDefinition[];
  signal: AbortSignal;
}

export interface ApiProviderAdapter {
  readonly provider: string;
  readonly capabilities: {
    streamingText: boolean;
    reasoning: boolean;
    toolCalls: boolean;
    attachments: AttachmentCapabilities;
  };
  stream(request: ApiProviderRequest): AsyncIterable<ApiProviderStreamEvent>;
}

export interface ApiProviderRuntimePolicy {
  reasoningSummary(round: number): string;
  finishReasonError(reason: string): ProtocolError | undefined;
  mapError(error: unknown): ProtocolError;
}
