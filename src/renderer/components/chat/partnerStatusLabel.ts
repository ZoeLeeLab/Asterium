// Apply only to runtime status templates, including previously saved rows.
export function partnerStatusLabel(summary: string, partnerName: string) {
  return summary.replace(
    /(^|[，。]\s*|\s+)(?:外部伙伴|本地伙伴|API 伙伴|伙伴|Claude Code|Codex|DeepSeek)\s*(?=正在|进入第|第 \d+ 段思考|继续|等待|需要|请求|已完成)/gu,
    (_match, separator: string) => separator + partnerName,
  );
}
