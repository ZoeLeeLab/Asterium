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
  "lastVerifiedCommit": null
}
---

API 伙伴 MCP、Skills 与网络工具的当前代码入口、测试和权限边界见以上元数据。

Skill 与 MCP stdio 沙箱为实验能力；远端 HTTP MCP 内部行为不由本地沙箱隔离。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
