import { HANDOFF_MAX_TEXT, handoffDraftSchema, type ContextHandoff } from '../../shared/contextHandoff';
import type { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import type { StudioRoomStore } from '../studio/StudioRoomStore';

export class ContextHandoffService {
  constructor(
    private readonly singleChats: Pick<SingleChatMessageStore, 'getConversation'>,
    private readonly rooms: Pick<StudioRoomStore, 'getRoom'>,
    private readonly eligible: (id: string) => boolean,
    private readonly displayName: (partnerId: string) => string,
  ) {}

  async validate(value: unknown, target: ContextHandoff['target'], partnerId?: string) {
    const draft = handoffDraftSchema.parse(value);
    if (draft.target.kind !== target.kind || draft.target.id !== target.id || (partnerId && draft.partnerId !== partnerId)
      || draft.source.kind === target.kind || !this.eligible(draft.partnerId)) throw new Error('HANDOFF_SCOPE_UNAVAILABLE');
    const singleId = draft.source.kind === 'single' ? draft.source.id : target.id;
    const roomId = draft.source.kind === 'group' ? draft.source.id : target.id;
    const [single, room] = await Promise.all([this.singleChats.getConversation(singleId), this.rooms.getRoom(roomId)]);
    if (!single || single.partnerId !== draft.partnerId || single.isArchived || single.isDisabled
      || !room || room.metadata.archived || !room.metadata.memberIds.includes(draft.partnerId)) throw new Error('HANDOFF_SCOPE_UNAVAILABLE');
    const selected = new Set(draft.messageIds);
    const messages = draft.source.kind === 'single'
      ? single.messages.filter(message => selected.has(message.messageId) && !message.automationRunId && message.fallbackEligible !== false
        && (message.authorType === 'user' || message.completedAt || message.fallbackEligible === true))
      : room.messages.filter(message => selected.has(message.messageId) && !message.automation && message.status === 'completed' && message.authorType !== 'system');
    if (messages.length !== draft.messageIds.length || messages.some(message => !message.content.trim())) throw new Error('HANDOFF_SOURCE_UNAVAILABLE');
    const text = messages.map(message => `${message.authorType === 'user' ? '用户' : this.displayName(message.authorId)}：${message.content}`).join('\n\n');
    if (text.length > HANDOFF_MAX_TEXT) throw new Error('HANDOFF_TEXT_TOO_LONG');
    return { ...draft, text };
  }
}
