---
{
  "name": "运行状态、项目与协作工具",
  "id": "asterium.runtime-tools",
  "appliesTo": [
    "api",
    "local_cli"
  ],
  "protocols": [
    "internal"
  ],
  "permissionBoundary": "按实际会话、工作区、群聊与授权提供工具；工具不存在时不得宣称可调用。",
  "status": "stable",
  "codeEntries": [
    "src/main/runtime/AsteriumRuntimeTools.ts",
    "src/main/notebook/PartnerProjectNotebookService.ts",
    "src/main/api/ApiAgentRuntime.ts",
    "src/renderer/components/chat/toolPresentation.ts",
    "src/renderer/components/chat/TurnTimeline.tsx",
    "src/shared/contracts/runtime.ts"
  ],
  "tests": [
    "tests/unit/asteriumRuntimeTools.test.ts",
    "tests/unit/partnerProjectNotebookService.test.ts",
    "tests/unit/apiAgentRuntime.test.ts",
    "tests/api-providers-acceptance.mjs",
    "tests/renderer/TurnTimelinePresentation.test.tsx",
    "tests/renderer/AutomationsView.test.tsx",
    "tests/unit/agentProtocol.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/release-status.md"
  ],
  "lastVerifiedCommit": null
}
---

运行状态、项目与协作工具的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
