import { randomUUID } from 'node:crypto';
import type { AdapterHost } from '../AdapterHost';
import type { PartnerAdapter } from '../adapters/PartnerAdapter';
import {
  AGENT_PROTOCOL_VERSION,
  type CancelRunCommand,
  type MessageDeliveryEvent,
  type PartnerEvent,
  type ResolveAuthorizationCommand,
  type ResolveUserInputCommand,
  type ResumeSessionCommand,
  type SendGuidanceCommand,
  type SendGuidanceResult,
  type SendMessageCommand,
  type SendMessageReceipt,
} from '../../shared/agentProtocol';
import { isPartnerEvent } from '../../shared/agentProtocolValidation';
import { conversationWriterScope, WriterLeaseCoordinator, type WriterLease } from './WriterLeaseCoordinator';

export interface RunCoordinatorHooks {
  prepare?: (command: SendMessageCommand) => Promise<void>;
  deliver: (command: SendMessageCommand, state: MessageDeliveryEvent['state'], error?: MessageDeliveryEvent['error']) => void;
  emit: (event: PartnerEvent) => void;
  observe: (event: PartnerEvent) => Promise<void>;
  validateFirstEvent?: (event: PartnerEvent, command: SendMessageCommand) => Promise<void>;
  onBound?: (event: Extract<PartnerEvent, { type: 'session.bound' }>, command: SendMessageCommand) => Promise<void>;
  beforeEvent?: (event: PartnerEvent, command: SendMessageCommand) => Promise<void>;
  onEvent?: (event: PartnerEvent, command: SendMessageCommand) => Promise<void>;
  transformEvent?: (event: PartnerEvent, artifactBaseDirectory?: string) => Promise<PartnerEvent | undefined>;
  onStreamFailure?: (error: unknown, context: RunFailureContext) => Promise<void>;
  onStartFailure?: (error: unknown, command: SendMessageCommand) => Promise<void>;
  onReleased?: (context: RunReleasedContext) => Promise<void>;
}

export interface RunFailureContext {
  command: SendMessageCommand;
  receipt: SendMessageReceipt;
  lastSequence: number;
}

export interface RunReleasedContext {
  command: SendMessageCommand;
  receipt: SendMessageReceipt;
}

export interface StartRunOptions {
  disposeAfter?: boolean;
  artifactBaseDirectory?: string;
}

export class RunCoordinator {
  private readonly idempotency = new Map<string, { fingerprint: string; receipt: Promise<SendMessageReceipt> }>();

  constructor(
    private readonly host: AdapterHost,
    private readonly hooks: RunCoordinatorHooks,
    private readonly writerLeases = new WriterLeaseCoordinator(),
  ) {}

  runIdempotent(clientMessageId: string, fingerprint: string, start: () => Promise<SendMessageReceipt>) {
    const prior = this.idempotency.get(clientMessageId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
      return prior.receipt;
    }
    const receipt = start();
    this.idempotency.set(clientMessageId, { fingerprint, receipt });
    void receipt.catch(() => {
      if (this.idempotency.get(clientMessageId)?.receipt === receipt) this.idempotency.delete(clientMessageId);
    });
    return receipt;
  }

  async start(adapter: PartnerAdapter, command: SendMessageCommand, options: StartRunOptions = {}): Promise<SendMessageReceipt> {
    if (/^(compact|reload):/.test(this.writerLeases.ownerFor(conversationWriterScope(command)) ?? '')) throw new Error('COMPACT_CONVERSATION_BUSY');
    const lease = await this.writerLeases.acquire(conversationWriterScope(command), `runtime:${command.commandId}`);
    this.hooks.deliver(command, 'awaiting_confirmation');
    try {
      await this.hooks.prepare?.(command);
      const iterator = adapter.sendMessage(command)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || !isPartnerEvent(first.value) || first.value.type !== 'session.bound') throw new Error('ADAPTER_SESSION_NOT_BOUND');
      const firstEvent = withCommandRoute(first.value, command) as Extract<PartnerEvent, { type: 'session.bound' }>;
      if (!sameEventRoute(firstEvent, command)) throw new Error('ADAPTER_EVENT_ROUTE_MISMATCH');
      await this.hooks.validateFirstEvent?.(firstEvent, command);
      await this.hooks.observe(firstEvent);
      this.hooks.emit(firstEvent);
      const receipt = { runId: firstEvent.runId, sessionId: firstEvent.sessionId };
      this.host.bindRun(receipt.runId, adapter);
      this.host.bindSession(command.partnerId, command.conversationId, receipt.sessionId, adapter);
      await this.hooks.onBound?.(firstEvent, command);
      void this.consume(iterator, adapter, command, receipt, firstEvent.sequence, options, lease);
      return receipt;
    } catch (error) {
      lease.release();
      await this.hooks.onStartFailure?.(error, command);
      this.hooks.deliver(command, 'failed', {
        code: 'ADAPTER_START_FAILED',
        message: '无法启动伙伴会话。',
        stage: 'adapter',
        retryable: true,
        technicalDetail: error instanceof Error ? error.message.slice(0, 500) : undefined,
      });
      throw error;
    }
  }

  async cancel(command: CancelRunCommand) {
    await this.host.adapterForRun(command.runId)?.cancel(command);
  }

  async sendGuidance(command: SendGuidanceCommand): Promise<SendGuidanceResult> {
    const adapter = this.host.adapterForRun(command.runId);
    if (!adapter?.capabilities.guidance || !adapter.sendGuidance) throw new Error('GUIDANCE_NOT_AVAILABLE');
    return adapter.sendGuidance(command);
  }

  async resolveAuthorization(command: ResolveAuthorizationCommand) {
    const adapter = this.host.adapterForRun(command.runId);
    if (!adapter?.capabilities.authorizationBridge) throw new Error('AUTHORIZATION_BRIDGE_NOT_AVAILABLE');
    if (command.persistExtensionTrust === true && adapter.connectionSource !== 'api_partner') throw new Error('EXTENSION_TRUST_NOT_OFFERED');
    await adapter.resolveAuthorization(command);
  }

  async resolveUserInput(command: ResolveUserInputCommand) {
    const adapter = this.host.adapterForRun(command.runId);
    if (!adapter?.capabilities.userInputBridge || !adapter.resolveUserInput) throw new Error('USER_INPUT_BRIDGE_NOT_AVAILABLE');
    await adapter.resolveUserInput(command);
  }

  async resume(command: ResumeSessionCommand) {
    const adapter = this.host.adapterForSession(command.partnerId, command.conversationId, command.sessionId);
    if (!adapter) return;
    const lease = await this.writerLeases.acquire(conversationWriterScope(command), `resume:${command.commandId}`);
    try {
      for await (const resumed of adapter.resumeSession(command)) {
        const routedEvent = withCommandRoute(resumed, command);
        if (!sameEventRoute(routedEvent, command)) throw new Error('ADAPTER_RESUME_ROUTE_MISMATCH');
        await this.hooks.observe(routedEvent);
        this.hooks.emit(routedEvent);
      }
    } finally {
      lease.release();
    }
  }

  clearIdempotency() {
    this.idempotency.clear();
  }

  private async consume(
    iterator: AsyncIterator<PartnerEvent>,
    adapter: PartnerAdapter,
    command: SendMessageCommand,
    receipt: SendMessageReceipt,
    initialSequence: number,
    options: StartRunOptions,
    lease: WriterLease,
  ) {
    let lastSequence = initialSequence;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        if (!isPartnerEvent(next.value)) continue;
        const routedEvent = withCommandRoute(next.value, command);
        if (!sameEventRoute(routedEvent, command) || routedEvent.sessionId !== receipt.sessionId || routedEvent.runId !== receipt.runId) throw new Error('ADAPTER_EVENT_ROUTE_MISMATCH');
        lastSequence = routedEvent.sequence;
        await this.hooks.beforeEvent?.(routedEvent, command);
        await this.hooks.observe(routedEvent);
        await this.hooks.onEvent?.(routedEvent, command);
        if (routedEvent.type === 'message.accepted') this.hooks.deliver(command, 'delivered');
        if (routedEvent.type === 'run.failed') this.hooks.deliver(command, 'failed', routedEvent.error);
        const outgoing = this.hooks.transformEvent
          ? await this.hooks.transformEvent(routedEvent, options.artifactBaseDirectory)
          : routedEvent;
        if (outgoing) this.hooks.emit(outgoing);
      }
    } catch (error) {
      await this.hooks.onStreamFailure?.(error, { command, receipt, lastSequence });
      this.hooks.deliver(command, 'failed', {
        code: 'ADAPTER_STREAM_FAILED',
        message: '伙伴的事件流意外中断。',
        stage: 'transport',
        retryable: true,
        technicalDetail: error instanceof Error ? error.message.slice(0, 500) : undefined,
      });
    } finally {
      this.host.releaseRun(receipt.runId);
      lease.release();
      if (options.disposeAfter) await adapter.dispose?.();
      await this.hooks.onReleased?.({ command, receipt });
    }
  }
}

export function sameEventRoute(event: PartnerEvent, command: Pick<SendMessageCommand | ResumeSessionCommand, 'partnerId' | 'conversationId' | 'connectionSource' | 'route'>) {
  const sameGroupRoute = command.route?.scope !== 'group' || (event.route?.scope === 'group'
    && event.route.roomId === command.route.roomId
    && event.route.roundId === command.route.roundId
    && event.route.bindingGeneration === command.route.bindingGeneration
    && event.route.inputThroughSeq === command.route.inputThroughSeq);
  const samePlanningRoute = command.route?.scope !== 'workflow_planning' || (event.route?.scope === 'workflow_planning'
    && event.route.projectId === command.route.projectId
    && event.route.roomId === command.route.roomId
    && event.route.generationId === command.route.generationId
    && event.route.bindingGeneration === command.route.bindingGeneration);
  return sameGroupRoute && samePlanningRoute
    && event.partnerId === command.partnerId
    && event.conversationId === command.conversationId
    && event.connectionSource === command.connectionSource;
}

export function withCommandRoute(event: PartnerEvent, command: Pick<SendMessageCommand | ResumeSessionCommand, 'route'>): PartnerEvent {
  return command.route ? { ...event, route: command.route } : event;
}

export function streamFailureEvent({ command, receipt, lastSequence }: RunFailureContext): PartnerEvent {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'run.failed',
    eventId: randomUUID(),
    partnerId: command.partnerId,
    conversationId: command.conversationId,
    connectionSource: command.connectionSource,
    clientMessageId: command.clientMessageId,
    sessionId: receipt.sessionId,
    runId: receipt.runId,
    sequence: lastSequence + 1,
    occurredAt: new Date().toISOString(),
    route: command.route,
    error: { code: 'ADAPTER_STREAM_FAILED', message: '伙伴的事件流意外中断。', stage: 'transport', retryable: true },
  };
}
