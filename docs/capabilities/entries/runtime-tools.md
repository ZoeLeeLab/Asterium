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
    "src/shared/contracts/runtime.ts",
    "src/main/adapters/ClaudeCliTransport.ts",
    "src/main/adapters/ClaudeCodeAdapter.ts"
  ],
  "tests": [
    "tests/unit/asteriumRuntimeTools.test.ts",
    "tests/unit/partnerProjectNotebookService.test.ts",
    "tests/unit/apiAgentRuntime.test.ts",
    "tests/api-providers-acceptance.mjs",
    "tests/renderer/TurnTimelinePresentation.test.tsx",
    "tests/renderer/AutomationsView.test.tsx",
    "tests/unit/agentProtocol.test.ts",
    "tests/unit/claudeCliBootstrap.test.ts",
    "tests/unit/nativeProfileReload.test.ts",
    "tests/unit/nativeProfileRecovery.test.ts",
    "tests/unit/nativeSessionCompaction.test.ts",
    "tests/claude-cli-acceptance.mjs"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/release-status.md",
    "docs/claude-cli-compatibility.md"
  ],
  "lastVerifiedCommit": "ccc08e5fbe9328f24b754d488892067751fdeff5"
}
---

运行状态、项目与协作工具的当前代码入口、测试和权限边界见以上元数据。

Claude 运行通道改为官方 CLI 与 stdio MCP；复用既有记忆、笔记、任务与协作工具，不另建业务服务。资料重读、恢复及压缩保留原服务与合成测试；官方 CLI 的主审批、取消、断连等有单独 Windows 本地合成验证，完整真实协作仍待验收。

本条核验绑定已存在代码提交 `ccc08e5fbe9328f24b754d488892067751fdeff5`，不继承旧候选验收归属。构建和人工验收分别以新候选独立报告为准；模拟、源码及配置核验不代表真实服务或普通账户验收通过。

官方 CLI 合成回归还覆盖明确 session ID 恢复及部分流事件；不等于真实订阅已验收。

Full 原生命令使用经用户授权的当前 Windows 账户权限；路径检查和受管资料服务不构成任意命令的操作系统级隔离。主审批、只读及取消约束继续生效。
