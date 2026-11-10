const MCP_WARNING = /^[\s\u200B\uFEFF]*(?:>\s*)?MCP\s*未就绪[：:][\s\S]{0,1000}?既有授权[。.]?\s*/u;

export function visibleAssistantText(text: string) {
  return text.replace(MCP_WARNING, '');
}
