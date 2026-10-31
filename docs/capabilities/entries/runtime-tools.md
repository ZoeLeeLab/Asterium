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
  "lastVerifiedCommit": "39122d3a15ba44f14568d6826b7dc5b590266cea"
}
---

运行状态、项目与协作工具的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

本条绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。
