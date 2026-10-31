---
{
  "name": "文件、命令与交付",
  "id": "asterium.workspace-tools",
  "appliesTo": [
    "api"
  ],
  "protocols": [
    "internal"
  ],
  "permissionBoundary": "文件限既有授权。默认/Full Native；可选 AppContainer+Job。普通审批仍走选定后端；非 Full 可单独申请仅本次 Native 命令审批，不变更设置或模式，不自动回退重放。",
  "status": "stable",
  "codeEntries": [
    "src/main/api/ApiAgentTools.ts",
    "src/main/execution/ExecutionGateway.ts",
    "src/main/execution/ExecutionPermissions.ts",
    "src/main/api/extensions/ExtensionLaunchBackend.ts",
    "src/main/security/PartnerWorkspaceStore.ts",
    "src/main/security/ArtifactRegistry.ts",
    "src/main/execution/ExecutionBackendRouter.ts",
    "src/main/execution/NativeCommandApproval.ts",
    "src/main/execution/SandboxExtensionLaunchBackend.ts",
    "src/main/execution/WindowsSandboxProcess.ts",
    "native/sandbox/WindowsSandboxHelper.cs"
  ],
  "tests": [
    "tests/unit/apiAgentTools.test.ts",
    "tests/unit/commandExecution.test.ts",
    "tests/unit/executionPermissions.test.ts",
    "tests/unit/partnerWorkspaceStore.test.ts",
    "tests/unit/artifactRegistry.test.ts",
    "tests/unit/executionBackendRouter.test.ts",
    "tests/unit/sandboxCommand.test.ts",
    "tests/unit/sandboxProcessProtocol.test.ts",
    "tests/unit/nativeCommandApproval.test.ts",
    "tests/native-command-approval-smoke.mjs"
  ],
  "docs": [
    "docs/release-status.md",
    "docs/capabilities/schema.md",
    "docs/native-command-approval.md"
  ],
  "lastVerifiedCommit": null
}
---

文件、命令与交付的当前代码入口、测试和权限边界见以上元数据。

Windows 沙箱为实验能力；Full 使用 Native，普通审批不授予沙箱外执行能力。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
