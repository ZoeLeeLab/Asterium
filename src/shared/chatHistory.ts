export const CHAT_HISTORY_BUDGET = { maxMessages: 30, maxCharacters: 60_000 } as const;
export function trimChatHistory<T extends { content: string }>(messages: T[]): T[] {
  const selected: T[] = []; let characters = 0;
  for (const message of messages.slice(-CHAT_HISTORY_BUDGET.maxMessages).reverse()) {
    if (characters + message.content.length > CHAT_HISTORY_BUDGET.maxCharacters) {
      const available = CHAT_HISTORY_BUDGET.maxCharacters - characters;
      if (available > 0) selected.push({ ...message, content: message.content.slice(-available) });
      break;
    }
    selected.push(message); characters += message.content.length;
  }
  return selected.reverse();
}
