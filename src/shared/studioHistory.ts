import { STUDIO_PUBLIC_HISTORY_BUDGET, type StudioRoomMessage } from './studioRuntime';

/** Preserve Studio's existing tail selection, including one oversized final message. */
export function selectStudioPublicContext(messages: StudioRoomMessage[]) {
  const selected = messages.slice(-STUDIO_PUBLIC_HISTORY_BUDGET.maxMessages);
  const size = (message: StudioRoomMessage) => message.content.length + (message.attachments?.length ? JSON.stringify(message.attachments).length : 0);
  let characters = selected.reduce((sum, message) => sum + size(message), 0);
  while (selected.length > 1 && characters > STUDIO_PUBLIC_HISTORY_BUDGET.maxCharacters) {
    characters -= size(selected.shift()!);
  }
  const first = selected[0];
  const originalFirst = messages[0];
  return {
    messages: selected.map((message) => structuredClone(message)),
    ...(first && originalFirst && first.seq > originalFirst.seq
      ? { omittedRange: { fromSeq: originalFirst.seq, throughSeq: first.seq - 1 } }
      : {}),
  };
}
