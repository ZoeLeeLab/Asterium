---
{
  "name": "Gemini 原生 Generate Content",
  "id": "asterium.api-gemini",
  "appliesTo": [
    "api"
  ],
  "protocols": [
    "gemini"
  ],
  "permissionBoundary": "原生片段仅同绑定回传；函数执行仍受星丛审批；跨协议旧工具结果只作为历史事实。",
  "status": "experimental",
  "codeEntries": [
    "src/main/adapters/GeminiAdapter.ts",
    "src/shared/apiEndpoints.ts"
  ],
  "tests": [
    "tests/unit/geminiAdapter.test.ts"
  ],
  "docs": [
    "docs/release-status.md"
  ],
  "lastVerifiedCommit": null
}
---

Gemini 原生 Generate Content的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
