---
{
  "name": "API 伙伴 MCP、Skills 与网络工具",
  "id": "asterium.api-extensions",
  "appliesTo": [
    "api"
  ],
  "protocols": [
    "mcp",
    "internal"
  ],
  "permissionBoundary": "沿用伙伴绑定/信任/审批和工作区真源；仅向目标进程提供其明确配置的凭据，不记录秘密。默认/Full Native 无隔离；可选本地沙箱实验中，管理 stdio 须独立目录 grant；HTTP 远端内部行为不受隔离。",
  "status": "stable",
  "codeEntries": [
    "src/main/api/extensions/ApiMcpSession.ts",
    "src/main/api/extensions/ApiSkillSession.ts",
    "src/main/api/extensions/McpConnectionManager.ts",
    "src/main/api/extensions/ExtensionLaunchBackend.ts",
    "src/main/execution/ExecutionGateway.ts",
    "src/main/execution/ExecutionPermissions.ts",
    "src/main/api/ApiWebTools.ts",
    "src/main/api/ApiToolRegistry.ts",
    "src/renderer/components/chat/toolPresentation.ts",
    "src/main/execution/ExecutionBackendRouter.ts",
    "src/main/execution/WindowsSandboxProcess.ts",
    "src/main/execution/SandboxExtensionLaunchBackend.ts",
    "src/main/execution/sandboxSkillPowerShell.ts",
    "src/main/execution/SandboxMcpTransport.ts",
    "src/main/api/extensions/McpManagementWorkspace.ts",
    "src/shared/apiExtensions.ts"
  ],
  "tests": [
    "tests/unit/apiMcpRuntime.test.ts",
    "tests/unit/apiSkills.test.ts",
    "tests/unit/apiSkillScripts.test.ts",
    "tests/unit/mcpConnectionManager.test.ts",
    "tests/unit/executionGateway.test.ts",
    "tests/unit/executionPermissions.test.ts",
    "tests/unit/apiWebTools.test.ts",
    "tests/unit/apiToolRegistry.test.ts",
    "tests/renderer/TurnTimelinePresentation.test.tsx",
    "tests/unit/sandboxSkill.test.ts",
    "tests/unit/sandboxSkillPowerShell.test.ts",
    "tests/unit/skillOnlyFixture.test.mjs",
    "tests/unit/sandboxMcpTransport.test.ts",
    "tests/unit/mcpManagementWorkspace.test.ts",
    "tests/unit/executionBackendRouter.test.ts",
    "tests/renderer/McpSettingsView.test.tsx",
    "tests/api-mcp-connection-smoke.mjs"
  ],
  "docs": [
    "docs/release-status.md",
    "docs/capabilities/schema.md",
    "docs/native-command-approval.md"
  ],
  "lastVerifiedCommit": "39122d3a15ba44f14568d6826b7dc5b590266cea"
}
---

API 伙伴 MCP、Skills 与网络工具的当前代码入口、测试和权限边界见以上元数据。

Skill 与 MCP stdio 沙箱为实验能力；远端 HTTP MCP 内部行为不由本地沙箱隔离。

本条绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。
