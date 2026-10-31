---
{
  "name": "Anthropic Messages",
  "id": "asterium.api-anthropic-messages",
  "appliesTo": [
    "api"
  ],
  "protocols": [
    "anthropic_messages"
  ],
  "permissionBoundary": "同绑定原样回传思考及签名内容块；工具仍由统一审批执行，不以签名扩大权限。",
  "status": "experimental",
  "codeEntries": [
    "src/main/adapters/AnthropicMessagesAdapter.ts",
    "src/shared/apiConnections.ts"
  ],
  "tests": [
    "tests/unit/anthropicMessagesAdapter.test.ts"
  ],
  "docs": [
    "docs/release-status.md"
  ],
  "lastVerifiedCommit": null
}
---

Anthropic Messages的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
