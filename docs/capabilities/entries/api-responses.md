---
{
  "name": "OpenAI Responses",
  "id": "asterium.api-responses",
  "appliesTo": [
    "api"
  ],
  "protocols": [
    "responses"
  ],
  "permissionBoundary": "沿用 API Agent 工具审批与授权；原生状态仅在同一绑定重放，不作为可见正文或指令。",
  "status": "experimental",
  "codeEntries": [
    "src/main/adapters/ResponsesAdapter.ts",
    "src/main/api/ApiAgentRuntime.ts"
  ],
  "tests": [
    "tests/unit/responsesAdapter.test.ts"
  ],
  "docs": [
    "docs/release-status.md"
  ],
  "lastVerifiedCommit": null
}
---

OpenAI Responses的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
