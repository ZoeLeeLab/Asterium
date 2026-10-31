import type {
  CancelRunCommand,
  ConnectionSource,
  PartnerEvent,
  ResolveAuthorizationCommand,
  ResolveUserInputCommand,
  ResumeSessionCommand,
  SendMessageCommand,
  SendGuidanceCommand,
  SendGuidanceResult,
} from '../../shared/agentProtocol';
import type { AsteriumRuntimeToolController } from '../runtime/AsteriumRuntimeTools';
import type { SessionCompactResult } from '../../shared/sessionCompaction';
import type { SessionBootstrapDocument } from '../../shared/agentProtocol';

export type { AsteriumRuntimeToolController };

export type AttachmentPathResolver = (attachmentId: string, conversationId: string) => Promise<string>;

export interface ExtensionEventRegistration {
  namespace: string;
  schemaVersions: readonly number[];
}

export interface PartnerAdapterCapabilities {
  streamingText: boolean;
  cancellation: boolean;
  sessionResume: boolean;
  toolEvents: boolean;
  fileEvents: boolean;
  authorizationBridge: boolean;
  userInputBridge?: boolean;
  nativePlan?: boolean;
  guidance?: 'native' | 'runtime' | 'deferred';
  compaction?: boolean;
  extensions: readonly ExtensionEventRegistration[];
}

export interface PartnerAdapter {
  readonly connectionSource: ConnectionSource;
  readonly capabilities: PartnerAdapterCapabilities;
  sendMessage(command: SendMessageCommand): AsyncIterable<PartnerEvent>;
  compactSession?(sessionId: string, signal: AbortSignal, bootstrap?: SessionBootstrapDocument): Promise<SessionCompactResult>;
  restoreProfileSnapshot?(sessionId: string, bootstrap: SessionBootstrapDocument): Promise<void>;
  reloadProfiles?(sessionId: string, prompt: string, bootstrap: SessionBootstrapDocument, signal: AbortSignal): Promise<string>;
  replaceRuntimeTools?(runtimeTools: AsteriumRuntimeToolController): void;
  replaceRuntimeWorkspaceRoots?(additionalDirectories: string[]): void;
  updateRuntimeContext?(command: SendMessageCommand): void;
  resumeSession(command: ResumeSessionCommand): AsyncIterable<PartnerEvent>;
  resolveAuthorization(command: ResolveAuthorizationCommand): Promise<void>;
  resolveUserInput?(command: ResolveUserInputCommand): Promise<void>;
  sendGuidance?(command: SendGuidanceCommand): Promise<SendGuidanceResult>;
  cancel(command: CancelRunCommand): Promise<void>;
  dispose?(): Promise<void>;
}
