---
{
  "name": "通用 Chat Completions",
  "id": "asterium.api-chat-completions",
  "appliesTo": [
    "api"
  ],
  "protocols": [
    "chat_completions"
  ],
  "permissionBoundary": "仅向用户配置的端点发送请求；模型能力不扩大现有工具授权。测试对话需用户主动点击。",
  "status": "experimental",
  "codeEntries": [
    "src/main/adapters/ChatCompletionsAdapter.ts",
    "src/main/api/ApiHttpTransport.ts",
    "src/shared/apiEndpoints.ts"
  ],
  "tests": [
    "tests/unit/chatCompletionsAdapter.test.ts",
    "tests/renderer/ApiConnectionsSettings.test.tsx"
  ],
  "docs": [
    "docs/release-status.md"
  ],
  "lastVerifiedCommit": null
}
---

通用 Chat Completions的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
