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
  "lastVerifiedCommit": "39122d3a15ba44f14568d6826b7dc5b590266cea"
}
---

Gemini 原生 Generate Content的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

本条绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。
