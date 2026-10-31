import type { Message, MessageQuote } from '../types/domain';

const MCP_WARNING = /^[\s\u200B\uFEFF]*(?:>\s*)?MCP\s*未就绪[：:][\s\S]{0,1000}?既有授权[。.]?\s*/u;

export function visibleAssistantText(text: string) {
  return text.replace(MCP_WARNING, '');
}

export function assistantMessageText(message: Message) {
  const timelineText: string[] = [];
  let segment = '';
  for (const item of message.timeline ?? []) {
    if (item.kind === 'text') {
      segment += item.text;
      continue;
    }
    const visible = visibleAssistantText(segment).trim();
    if (visible) timelineText.push(visible);
    segment = '';
  }
  const trailing = visibleAssistantText(segment).trim();
  if (trailing) timelineText.push(trailing);
  if (timelineText.length) return timelineText.join('\n\n');
  return visibleAssistantText(message.content).trim();
}

export function formatMessageWithQuote(content: string, quote?: MessageQuote) {
  if (!quote) return content;
  const kind = quote.kind === 'full' ? '完整回复' : '选中片段';
  return `[引用内容 · ${quote.sourcePartnerName} · ${kind}]\n${quote.text}\n[引用结束]\n\n[用户本轮消息]\n${content}`;
}

export function messageTextForRuntime(message: Message) {
  return formatMessageWithQuote(message.content, message.quote);
}
