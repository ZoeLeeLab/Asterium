import type { PartnerAdapter } from '../../src/main/adapters/PartnerAdapter';
import {
  AGENT_PROTOCOL_VERSION,
  type AdapterEventBase,
  type CancelRunCommand,
  type PartnerEvent,
  type ResolveAuthorizationCommand,
  type ResumeSessionCommand,
  type SendMessageCommand,
} from '../../src/shared/agentProtocol';

type Scenario = 'normal' | 'tool' | 'failure' | 'cancel';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export class MockAdapter implements PartnerAdapter {
  readonly connectionSource = 'local_cli' as const;
  readonly capabilities = {
    streamingText: true,
    cancellation: true,
    sessionResume: true,
    toolEvents: true,
    fileEvents: true,
    authorizationBridge: true,
    extensions: [{ namespace: 'test.mock', schemaVersions: [1] }] as const,
  };
  readonly executionCount = new Map<string, number>();
  private readonly cached = new Map<string, { fingerprint: string; events: PartnerEvent[] }>();
  private readonly sessionEvents = new Map<string, PartnerEvent[]>();
  private readonly cancellations = new Map<string, Deferred<string>>();
  private readonly authorizations = new Map<string, Deferred<'allow_once' | 'deny'>>();
  private eventCounter = 0;
  private sessionCounter = 0;

  constructor(private readonly scenario: Scenario = 'normal') {}

  sendMessage(command: SendMessageCommand): AsyncIterable<PartnerEvent> {
    const fingerprint = JSON.stringify({
      partnerId: command.partnerId,
      conversationId: command.conversationId,
      connectionSource: command.connectionSource,
      sessionId: command.sessionId,
      content: command.content,
    });
    const cached = this.cached.get(command.clientMessageId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
      return this.replay(cached.events);
    }

    this.executionCount.set(command.clientMessageId, (this.executionCount.get(command.clientMessageId) ?? 0) + 1);
    return this.execute(command, fingerprint);
  }

  async *resumeSession(command: ResumeSessionCommand): AsyncIterable<PartnerEvent> {
    const events = this.sessionEvents.get(command.sessionId) ?? [];
    for (const event of events.filter((item) => item.sequence > command.afterSequence)) yield structuredClone(event);
  }

  async resolveAuthorization(command: ResolveAuthorizationCommand) {
    this.authorizations.get(command.authorizationId)?.resolve(command.decision);
  }

  async cancel(command: CancelRunCommand) {
    this.cancellations.get(command.runId)?.resolve(command.reason ?? '用户取消');
  }

  private async *execute(command: SendMessageCommand, fingerprint: string): AsyncIterable<PartnerEvent> {
    const sessionId = command.sessionId ?? `session-${++this.sessionCounter}`;
    const runId = `run-${command.clientMessageId}`;
    const events: PartnerEvent[] = [];
    const emit = <T extends Omit<PartnerEvent, keyof AdapterEventBase>>(event: T) => {
      const complete = {
        ...event,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        eventId: `event-${++this.eventCounter}`,
        partnerId: command.partnerId,
        conversationId: command.conversationId,
        connectionSource: command.connectionSource,
        clientMessageId: command.clientMessageId,
        sessionId,
        runId,
        sequence: (this.sessionEvents.get(sessionId)?.at(-1)?.sequence ?? 0) + events.length + 1,
        occurredAt: new Date(this.eventCounter * 1000).toISOString(),
      } as PartnerEvent;
      events.push(complete);
      return complete;
    };

    yield emit({ type: 'session.bound', isNew: !command.sessionId });
    yield emit({ type: 'message.accepted' });

    if (this.scenario === 'normal') {
      yield emit({ type: 'work.status', state: 'thinking', summary: '正在思考' });
      yield emit({ type: 'text.delta', text: '你好，' });
      yield emit({ type: 'text.delta', text: '星丛。' });
      yield emit({ type: 'run.completed', finishReason: 'end_turn' });
    } else if (this.scenario === 'failure') {
      yield emit({
        type: 'run.failed',
        error: { code: 'MOCK_FAILURE', message: '模拟失败', stage: 'adapter', retryable: true },
      });
    } else if (this.scenario === 'cancel') {
      const gate = deferred<string>();
      this.cancellations.set(runId, gate);
      yield emit({ type: 'text.delta', text: '开始处理' });
      const reason = await gate.promise;
      yield emit({ type: 'run.cancelled', reason });
    } else {
      const authorizationId = `authorization-${runId}`;
      const toolCallId = `tool-${runId}`;
      const gate = deferred<'allow_once' | 'deny'>();
      this.authorizations.set(authorizationId, gate);
      yield emit({ type: 'tool.started', toolCallId, toolName: 'Write', summary: '准备写入文件', mutatesExternalState: true });
      yield emit({
        type: 'authorization.requested',
        authorizationId,
        toolCallId,
        action: 'write_file',
        risk: 'medium',
        summary: '需要写入测试文件',
        targets: ['result.md'],
      });
      const decision = await gate.promise;
      yield emit({ type: 'authorization.resolved', authorizationId, decision });
      if (decision === 'deny') {
        yield emit({ type: 'tool.completed', toolCallId, outcome: 'failure', summary: '用户拒绝' });
        yield emit({
          type: 'run.failed',
          error: { code: 'AUTHORIZATION_DENIED', message: '用户拒绝授权', stage: 'authorization', retryable: false },
        });
      } else {
        yield emit({ type: 'tool.progress', toolCallId, summary: '正在写入' });
        yield emit({ type: 'tool.completed', toolCallId, outcome: 'success', summary: '写入完成' });
        yield emit({ type: 'file.produced', artifactId: `artifact-${runId}`, toolCallId, name: 'result.md', artifactRef: 'mock://result.md' });
        yield emit({ type: 'run.completed', finishReason: 'completed' });
      }
    }

    this.cached.set(command.clientMessageId, { fingerprint, events: structuredClone(events) });
    const journal = this.sessionEvents.get(sessionId) ?? [];
    journal.push(...structuredClone(events));
    this.sessionEvents.set(sessionId, journal);
  }

  private async *replay(events: PartnerEvent[]) {
    for (const event of events) yield structuredClone(event);
  }
}
