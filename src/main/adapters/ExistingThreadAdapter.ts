import { randomUUID } from 'node:crypto';
import { cyberBossChatAttachmentError, cyberBossChatAttachmentHint, isCyberBossChatImage } from '../../shared/cyberBossChatAttachments';
import type { PartnerAdapter } from './PartnerAdapter';
import { CyberBossBridgeClient } from './CyberBossBridgeClient';
import type { CyberBossChatEvent, CyberBossSseEvent } from './cyberBossSseParser';
import { MarkdownArtifactParser } from './markdownArtifactParser';
import {
  AGENT_PROTOCOL_VERSION,
  type AdapterEventBase,
  type CancelRunCommand,
  type PartnerEvent,
  type ResolveAuthorizationCommand,
  type ResumeSessionCommand,
  type SendMessageCommand,
} from '../../shared/agentProtocol';

export class ExistingThreadAdapter implements PartnerAdapter {
  readonly connectionSource = 'existing_thread' as const;
  readonly capabilities = {
    streamingText: true,
    cancellation: false,
    sessionResume: true,
    toolEvents: false,
    fileEvents: false,
    authorizationBridge: false,
    extensions: [] as const,
  };

  private followup?: { controller: AbortController; done: Promise<void> };
  private replyRoute?: { command: SendMessageCommand; threadId: string };

  constructor(
    private readonly client: CyberBossBridgeClient,
    private threadId: string,
    private readonly onReply?: (command: SendMessageCommand, threadId: string, reply: CyberBossChatEvent) => void,
    private readonly readAttachment?: (id: string, conversationId: string, messageId: string) => Promise<Uint8Array>,
  ) {}

  async dispose() {
    this.replyRoute = undefined;
    await this.stopFollowup();
  }

  private async stopFollowup() {
    const followup = this.followup;
    followup?.controller.abort();
    await followup?.done;
    if (this.followup === followup) this.followup = undefined;
  }

  private observeFollowup(incoming: CyberBossSseEvent) {
    if (incoming.event === 'thread_changed') {
      this.threadId = incoming.threadId;
      this.replyRoute = undefined;
      return;
    }
    const route = this.replyRoute;
    if (!route) return;
    if (incoming.role === 'user') {
      // A replayed echo of the original question does not start a new turn.
      if (!incoming.clientMessageId || incoming.clientMessageId !== route.command.clientMessageId) this.replyRoute = undefined;
      return;
    }
    if (incoming.role === 'assistant' && incoming.text && incoming.id
      && (!incoming.clientMessageId || incoming.clientMessageId === route.command.clientMessageId)) {
      this.onReply?.(route.command, route.threadId, incoming);
    }
  }

  private async readFollowups(stream: AsyncIterator<CyberBossSseEvent>, signal: AbortSignal) {
    try {
      while (!signal.aborted && this.replyRoute) {
        const next = await stream.next();
        if (next.done) return;
        this.observeFollowup(next.value);
      }
    } catch {
      // The next send re-authenticates after a fatal stream error.
    } finally {
      await stream.return?.().catch(() => undefined);
    }
  }

  async *sendMessage(command: SendMessageCommand): AsyncIterable<PartnerEvent> {
    const runId = `cyberboss-run-${randomUUID()}`;
    let sequence = 0;
    const controller = new AbortController();
    const attachments = command.attachments ?? [];
    const hasFiles = attachments.some(attachment => !isCyberBossChatImage(attachment));
    const threadId = command.sessionId ?? this.threadId;
    const markdownImages = new MarkdownArtifactParser();
    let imageCounter = 0;
    const event = <T extends Omit<PartnerEvent, keyof AdapterEventBase>>(value: T) => ({
      ...value,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: `cyberboss-event-${randomUUID()}`,
      partnerId: command.partnerId,
      conversationId: command.conversationId,
      connectionSource: command.connectionSource,
      clientMessageId: command.clientMessageId,
      sessionId: hasFiles ? threadId : this.threadId,
      runId,
      sequence: ++sequence,
      occurredAt: new Date().toISOString(),
    } as PartnerEvent);
    let stream: AsyncIterator<CyberBossSseEvent> | undefined;
    let pending: Promise<IteratorResult<CyberBossSseEvent>> | undefined;
    let firstReplyDelivered = false;
    try {
      await this.stopFollowup();
      yield event({ type: 'session.bound', isNew: false });
      const mediaIds: string[] = [];
      const attachmentIds: string[] = [];
      if (attachments.length) {
        if (command.content.text.length > 8_000) throw new Error('CYBERBOSS_CHAT_TEXT_TOO_LONG');
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(command.clientMessageId)) throw new Error('CYBERBOSS_CHAT_MESSAGE_ID_INVALID');
        const policy = hasFiles ? await this.client.chatFileCapabilities() : undefined;
        if (hasFiles && !policy) throw new Error('CYBERBOSS_CHAT_FILE_UNAVAILABLE');
        const problem = cyberBossChatAttachmentError(attachments, policy);
        if (problem) throw new Error(problem);
        const readAttachment = this.readAttachment;
        const messageId = command.messageId;
        if (!readAttachment || !messageId) throw new Error('CYBERBOSS_CHAT_ATTACHMENT_UNAVAILABLE');
        if (threadId !== this.threadId || (await this.client.checkSession(true)).threadId !== threadId) {
          throw new Error('CYBERBOSS_CHAT_THREAD_CHANGED');
        }
        const snapshots = await Promise.all(attachments.map(async attachment => {
          const bytes = await readAttachment(attachment.id, command.conversationId, messageId);
          if (bytes.byteLength !== attachment.sizeBytes) throw new Error('CYBERBOSS_CHAT_ATTACHMENT_UNAVAILABLE');
          return { attachment, bytes };
        }));
        for (const { attachment, bytes } of snapshots) {
          if (isCyberBossChatImage(attachment)) mediaIds.push(await this.client.uploadChatImage(attachment, bytes, hasFiles));
          else attachmentIds.push(await this.client.uploadChatFile(attachment, bytes, threadId));
        }
        if (!hasFiles && (await this.client.checkSession(true)).threadId !== threadId) throw new Error('CYBERBOSS_CHAT_THREAD_CHANGED');
      } else {
        await this.client.checkSession();
      }
      stream = this.client.events(controller.signal)[Symbol.asyncIterator]();
      pending = stream.next();
      void pending.catch(() => undefined);
      let ownUserEventSeen = false;
      if (hasFiles) {
        await this.client.sendChatWithFiles({ text: command.content.text, clientMessageId: command.clientMessageId, mediaIds, attachmentIds, threadId });
      } else {
        await this.client.sendMessage(command.content.text, command.clientMessageId, mediaIds);
      }
      yield event({ type: 'message.accepted' });
      for (;;) {
        const next = await (pending ?? stream.next());
        pending = undefined;
        if (next.done) throw new Error('CYBERBOSS_STREAM_INTERRUPTED');
        const incoming = next.value;
        if (incoming.event === 'thread_changed') {
          this.observeFollowup(incoming);
          ownUserEventSeen = false;
          continue;
        }
        if (incoming.role === 'user') {
          this.observeFollowup(incoming);
          ownUserEventSeen = incoming.clientMessageId === command.clientMessageId;
          continue;
        }
        if (!ownUserEventSeen) {
          this.observeFollowup(incoming);
          continue;
        }
        if (incoming.clientMessageId && incoming.clientMessageId !== command.clientMessageId) continue;
        if (incoming.role === 'status' && incoming.status === 'typing') yield event({ type: 'work.status', state: 'thinking', summary: '外部伙伴正在输入…' });
        if (incoming.role === 'error') {
          yield event({ type: 'run.failed', error: { code: 'CYBERBOSS_REMOTE_ERROR', message: incoming.text || '外部伙伴桥接返回了错误。', stage: 'adapter', retryable: true } });
          return;
        }
        if (incoming.role === 'assistant' && incoming.text) {
          const parsed = markdownImages.push(incoming.text);
          if (parsed.text) yield event({ type: 'text.delta', text: parsed.text });
          for (const claim of parsed.claims) yield event({ type: 'file.produced', artifactId: `cyberboss-message-image-${++imageCounter}`, name: claim.name, artifactRef: 'registry-pending', mediaType: claim.mediaType, source: claim.source, registrationMethod: 'message_image' });
          yield event({ type: 'work.status', state: 'idle', summary: '外部伙伴已完成回复。' });
          firstReplyDelivered = true;
          yield event({ type: 'run.completed', finishReason: 'end_turn' });
          return;
        }
      }
    } catch (error) {
      yield event({ type: 'run.failed', error: bridgeError(error) });
    } finally {
      // The local send is released after the first reply. Keep consuming the same SSE cursor.
      if (firstReplyDelivered && stream && this.onReply) {
        this.replyRoute = { command, threadId: hasFiles ? threadId : this.threadId };
        this.followup = { controller, done: this.readFollowups(stream, controller.signal) };
      } else {
        controller.abort();
        await pending?.catch(() => undefined);
        await stream?.return?.().catch(() => undefined);
      }
    }
  }

  async cancel(_command: CancelRunCommand) {
    void _command;
    throw new Error('CYBERBOSS_CANCEL_NOT_SUPPORTED');
  }

  async *resumeSession(_command: ResumeSessionCommand): AsyncIterable<PartnerEvent> {
    void _command;
    for (const event of [] as PartnerEvent[]) yield event;
  }

  async resolveAuthorization(_command: ResolveAuthorizationCommand) {
    void _command;
    throw new Error('AUTHORIZATION_BRIDGE_NOT_AVAILABLE');
  }
}

function bridgeError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'CYBERBOSS_AUTH_FAILED') return { code, message: 'CyberBoss 认证失败，请重新检查认证信息。', stage: 'authorization' as const, retryable: false };
  const hint = cyberBossChatAttachmentHint(code);
  if (hint) return { code, message: hint, stage: 'adapter' as const, retryable: false };
  const attachmentErrors = new Map([
    ['CYBERBOSS_CHAT_TEXT_TOO_LONG', '附件消息的正文最多 8000 字符。'],
    ['CYBERBOSS_CHAT_ATTACHMENT_UNAVAILABLE', '无法读取本轮的附件，请重新添加。'],
    ['CYBERBOSS_CHAT_THREAD_CHANGED', 'CyberBoss 活跃线程已变化，本条消息未提交。请确认目标线程后重新选择附件。'],
    ['CYBERBOSS_CHAT_IMAGE_UPLOAD_FAILED', '图片上传失败，本条消息未提交。'],
    ['CYBERBOSS_CHAT_FILE_UPLOAD_FAILED', '文件上传失败，本条消息未提交。'],
    ['CYBERBOSS_CHAT_FILE_NAME', '文件名含有不支持的字符，请修改文件名后重新添加。'],
    ['CYBERBOSS_CHAT_FILE_SIGNATURE', '文件内容与其格式不匹配，请检查后重新添加。'],
    ['CYBERBOSS_CHAT_ATTACHMENT_INVALID', 'CyberBoss 拒绝了附件引用，请重新添加附件。'],
    ['CYBERBOSS_CHAT_ATTACHMENT_FORBIDDEN', '当前 CyberBoss 会话无权使用这些附件，请重新添加。'],
    ['CYBERBOSS_CHAT_ATTACHMENT_EXPIRED', '附件上传凭据已过期，请重新添加。'],
    ['CYBERBOSS_CHAT_MESSAGE_REJECTED', 'CyberBoss 拒绝了这条附件消息。'],
    ['CYBERBOSS_CHAT_MESSAGE_UNCERTAIN', '附件消息的发送结果待确认，请先检查原线程，避免重复发送。'],
  ]);
  const attachmentError = attachmentErrors.get(code);
  if (attachmentError) return { code, message: attachmentError, stage: 'transport' as const, retryable: false };
  if (code === 'CYBERBOSS_IDEMPOTENCY_CONFLICT') return { code, message: '消息幂等 ID 与之前内容冲突，已拒绝重复执行。', stage: 'transport' as const, retryable: false };
  return { code: code.startsWith('CYBERBOSS_') ? code : 'CYBERBOSS_BRIDGE_ERROR', message: '无法连接外部伙伴桥接，请检查 Tailscale、网络或稍后重试。', stage: 'transport' as const, retryable: true };
}
