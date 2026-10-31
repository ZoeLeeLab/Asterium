export const AGENT_PROTOCOL_VERSION = 2 as const;

export type PartnerId = string;
export type ConversationId = string;
export type SessionId = string;
export type RunId = string;
export type ClientMessageId = string;
export type CommandId = string;
export type EventId = string;
export type ConnectionSource = 'existing_thread' | 'local_cli' | 'api_partner';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MessageDeliveryState = 'sending' | 'awaiting_confirmation' | 'delivered' | 'failed';
export type PermissionMode = 'read_only' | 'manual' | 'automatic' | 'full';
export type PlanMode = 'default' | 'plan';
export type RunState = 'running' | 'waiting_authorization' | 'waiting_user_input' | 'completed' | 'failed' | 'cancelled';
export type ArtifactSourceKind = 'local_path' | 'remote_ref' | 'content';
export type ArtifactRegistrationMethod = 'automatic' | 'deliver_tool' | 'manual' | 'message_image';
export type ArtifactAvailability = 'available' | 'missing' | 'unavailable';
export type AuthorizationPurpose = 'operation' | 'workspace_add' | 'workspace_remove' | 'command_native';
export type NativeThreadScope = 'single' | 'group' | 'workspace' | 'workflow_planning';

export interface ProtocolError {
  code: string;
  message: string;
  stage: 'validation' | 'discovery' | 'authorization' | 'transport' | 'adapter' | 'tool' | 'unknown';
  retryable: boolean;
  technicalDetail?: string;
}

export interface RuntimeModelObservation {
  model: string;
  status: 'current' | 'recent' | 'unknown';
  observedAt: string;
  source: 'runtime' | 'native_thread' | 'history';
  conversationId?: string;
  threadId?: string;
}
