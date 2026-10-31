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
  "lastVerifiedCommit": "39122d3a15ba44f14568d6826b7dc5b590266cea"
}
---

通用自动化的当前代码入口、测试和权限边界见以上元数据。

外部宿主定时派发仍需独立 Adapter 与真实联调。

本条绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。
