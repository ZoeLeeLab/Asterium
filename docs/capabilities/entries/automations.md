---
{
  "name": "通用自动化",
  "id": "asterium.automations",
  "appliesTo": [
    "api",
    "local_cli",
    "external_adapter"
  ],
  "protocols": [
    "internal",
    "MCP"
  ],
  "permissionBoundary": "Main 持久调度 API／本地伙伴，复用原线程与当前审批，工作区或绑定变化停止执行。管理工具固定本人身份，可信发起会话完整权限下直接保存五类计划变更，其他可写模式仍确认，只读／Plan 禁止修改；自动运行禁止递归管理或持久增删工作区。外部管理默认关闭，外部凭据不证明完整权限，外部宿主执行尚未接线。",
  "status": "experimental",
  "codeEntries": [
    "src/shared/automations.ts",
    "src/shared/automationTool.ts",
    "src/shared/automationAdapter.ts",
    "src/main/automation/AutomationStore.ts",
    "src/main/automation/AutomationSchedule.ts",
    "src/main/automation/AutomationScheduler.ts",
    "src/main/automation/AutomationService.ts",
    "src/main/automation/AutomationRuntime.ts",
    "src/main/automation/AutomationAgentTools.ts",
    "src/main/automation/AutomationConfirmations.ts",
    "src/main/automation/automationAdapterSdk.ts",
    "src/renderer/components/settings/AutomationsView.tsx",
    "src/renderer/components/settings/AutomationConfirmationDialog.tsx",
    "src/renderer/components/layout/WorkspaceShortcuts.tsx"
  ],
  "tests": [
    "tests/unit/automation.test.ts",
    "tests/unit/automationRuntime.test.ts",
    "tests/unit/automationAgentTools.test.ts",
    "tests/unit/automationConfirmations.test.ts",
    "tests/unit/automationAdapter.test.ts",
    "tests/unit/automationReducer.test.ts",
    "tests/automation-adapter-acceptance.mjs",
    "tests/renderer/AutomationsView.test.tsx",
    "tests/renderer/AutomationConfirmationDialog.test.tsx",
    "tests/renderer/WorkspaceShortcuts.test.tsx",
    "tests/studio-browser-smoke.mjs"
  ],
  "docs": [
    "docs/release-status.md",
    "docs/automation-adapter-contract.md",
    "docs/automations-user-guide.md"
  ],
  "lastVerifiedCommit": null
}
---

通用自动化的当前代码入口、测试和权限边界见以上元数据。

外部宿主定时派发仍需独立 Adapter 与真实联调。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
