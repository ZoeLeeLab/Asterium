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
    "native/sandbox/WindowsSandboxHelper.cs",
    "src/main/execution/SandboxExtensionLaunchBackend.ts"
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
  "lastVerifiedCommit": "bff2507f7dfab0cfca4436e7b754b2557554d3de"
}
---

文件、命令与交付的当前代码入口、测试和权限边界见以上元数据。

Windows 沙箱为实验能力；Full 使用 Native，普通审批不授予沙箱外执行能力。

本条绑定已存在的本轮代码基线 `bff2507f7dfab0cfca4436e7b754b2557554d3de`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。

本轮仅修复 PowerShell 命令输出的 UTF-8 编码，使中文临时路径与子进程工作目录正确传回。原有中文路径断言保持，未扩大执行权限或变更 Codex 接入。
