import type { ExistingThreadConnection, ExistingThreadConnectionStatus, SendMessageCommand, SendMessageReceipt } from '../../shared/agentProtocol';
import { CyberBossBridgeClient } from '../adapters/CyberBossBridgeClient';
import type { PartnerAdapter } from '../adapters/PartnerAdapter';
import type { CredentialStore } from '../security/CredentialStore';
import type { BridgeCursorStore } from '../security/BridgeCursorStore';
import type { ConversationAttachmentStore } from '../security/ConversationAttachmentStore';
import type { ExistingThreadWatchRegistry } from './ExistingThreadWatchRegistry';
import type { PartnerRuntimeFactory } from './PartnerRuntimeFactory';
import type { RunCoordinator } from './RunCoordinator';

export interface ExistingThreadSendRequest {
  connection: ExistingThreadConnection;
  command: SendMessageCommand;
}

export interface ExistingThreadWatchRequest {
  partnerId: string;
  connection: ExistingThreadConnection;
}

interface Dependencies {
  credentials: Pick<CredentialStore, 'get'>;
  bridgeCursors: Pick<BridgeCursorStore, 'get' | 'set'>;
  existingThreadWatches: ExistingThreadWatchRegistry<ExistingThreadConnectionStatus>;
  messageAttachments: Pick<ConversationAttachmentStore, 'prepareSend'>;
  protectedRoots: readonly string[];
  hydrateManagedRuntimeProfile(command: SendMessageCommand): Promise<unknown>;
  runCoordinator: Pick<RunCoordinator, 'runIdempotent'>;
  runtimeFactory: Pick<PartnerRuntimeFactory, 'getExisting'>;
  startRun(adapter: PartnerAdapter, command: SendMessageCommand): Promise<SendMessageReceipt>;
  sendExistingThreadChanged(partnerId: string, change: { threadId: string; previousThreadId?: string; workspaceRoot: string; reason: string }): void;
  onReply: NonNullable<Parameters<PartnerRuntimeFactory['getExisting']>[1]>;
}

export function createExistingThreadService({
  credentials, bridgeCursors, existingThreadWatches, messageAttachments, protectedRoots, hydrateManagedRuntimeProfile,
  runCoordinator, runtimeFactory, startRun, sendExistingThreadChanged, onReply,
}: Dependencies) {
  const existingThreadStatus = (connection: ExistingThreadConnection, session: { threadId?: string; workspaceRoot?: string }): ExistingThreadConnectionStatus => ({
    credentialRef: connection.credentialRef,
    configured: true,
    masked: '••••••••',
    authenticated: true,
    threadId: session.threadId ?? connection.threadId,
    ...(session.workspaceRoot ? { workspaceRoot: session.workspaceRoot } : {}),
    capabilities: { streamingText: true, cancellation: false, toolEvents: false, fileEvents: false, reconnect: true },
  });

  async function testConnection(connection: ExistingThreadConnection) {
    const secret = await credentials.get(connection.credentialRef);
    if (!secret) throw new Error('CYBERBOSS_CREDENTIAL_REQUIRED');
    const client = new CyberBossBridgeClient({ serviceUrl: connection.serviceUrl, secret });
    const session = await client.checkSession();
    if (!session.threadId) throw new Error('CYBERBOSS_THREAD_ID_REQUIRED');
    return {
      credentialRef: connection.credentialRef,
      configured: true,
      masked: '••••••••',
      authenticated: true,
      threadId: session.threadId,
      ...(session.workspaceRoot ? { workspaceRoot: session.workspaceRoot } : {}),
        capabilities: { streamingText: true, cancellation: false, toolEvents: false, fileEvents: false, reconnect: true },
    } satisfies ExistingThreadConnectionStatus;
  }

  async function watch(request: ExistingThreadWatchRequest) {
    const signature = JSON.stringify(request.connection);
    try {
      return await existingThreadWatches.watch(request.partnerId, signature, async (signal) => {
        const secret = await credentials.get(request.connection.credentialRef);
        if (signal.aborted) throw new Error('EXISTING_THREAD_WATCH_ABORTED');
        if (!secret) throw new Error('CYBERBOSS_CREDENTIAL_REQUIRED');
        const cursorKey = `${request.partnerId}:watch`;
        const initialLastEventId = await bridgeCursors.get(cursorKey);
        if (signal.aborted) throw new Error('EXISTING_THREAD_WATCH_ABORTED');
        const client = new CyberBossBridgeClient({
          serviceUrl: request.connection.serviceUrl,
          secret,
          initialLastEventId,
          onLastEventId: (eventId) => { void bridgeCursors.set(cursorKey, eventId); },
        });
        const session = await client.checkSession();
        if (signal.aborted) throw new Error('EXISTING_THREAD_WATCH_ABORTED');
        if (session.threadId && session.workspaceRoot && (session.threadId !== request.connection.threadId || session.workspaceRoot !== request.connection.workspaceRoot)) sendExistingThreadChanged(request.partnerId, {
          threadId: session.threadId,
          previousThreadId: session.threadId === request.connection.threadId ? undefined : request.connection.threadId,
          workspaceRoot: session.workspaceRoot,
          reason: 'session_sync',
        });
        void (async () => {
          try {
            for await (const incoming of client.events(signal)) {
              if (incoming.event !== 'thread_changed') continue;
              sendExistingThreadChanged(request.partnerId, incoming);
            }
          } catch {
            // The next renderer watch or application restart will re-authenticate.
          } finally {
            existingThreadWatches.release(request.partnerId, signal);
          }
        })();
        return existingThreadStatus(request.connection, session);
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'EXISTING_THREAD_WATCH_ABORTED') return existingThreadStatus(request.connection, {});
      throw error;
    }
  }

  async function fileCapabilities(connection: ExistingThreadConnection) {
    const secret = await credentials.get(connection.credentialRef);
    if (!secret) throw new Error('CYBERBOSS_CREDENTIAL_REQUIRED');
    return new CyberBossBridgeClient({ serviceUrl: connection.serviceUrl, secret }).chatFileCapabilities();
  }

  async function send(request: ExistingThreadSendRequest, connection: ExistingThreadConnection) {
    request.command = await messageAttachments.prepareSend(request.command, protectedRoots);
    await hydrateManagedRuntimeProfile(request.command);
    const fingerprint = JSON.stringify({ connection, command: request.command });
    return runCoordinator.runIdempotent(request.command.clientMessageId, fingerprint, async () => {
      const adapter = await runtimeFactory.getExisting({
        partnerId: request.command.partnerId,
        credentialRef: connection.credentialRef,
        serviceUrl: connection.serviceUrl,
        threadId: connection.threadId,
      }, onReply);
      return startRun(adapter, request.command);
    });
  }

  return { testConnection, watch, fileCapabilities, send, stopWatch: (partnerId: string) => existingThreadWatches.stop(partnerId) };
}
