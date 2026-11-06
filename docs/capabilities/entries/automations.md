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
    "src/renderer/components/layout/WorkspaceShortcuts.tsx",
    "src/main/agentIpc.ts"
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
    "tests/studio-browser-smoke.mjs",
    "tests/unit/runtimeEnvironment.test.ts"
  ],
  "docs": [
    "docs/release-status.md",
    "docs/automation-adapter-contract.md",
    "docs/automations-user-guide.md",
    "docs/data-isolation.md",
    "docs/development-data-isolation-s1.md",
    "docs/automatic-test-isolation.md",
    "docs/development-data-isolation-progress.md",
    "docs/development-data-isolation-s5.md"
  ],
  "lastVerifiedCommit": "89a6c2dfd803b470690f1a2993d8ba729e981dca"
}
---

## 当前源码核验：2026-11-02 S5

本条绑定已存在的代码提交 `89a6c2dfd803b470690f1a2993d8ba729e981dca`；本次为纯文档核验，不使用自身或未来提交号。非日常启动默认不恢复计划调度，writer availability 也不自动触发扫描；同一启动选择约束日记、记忆兜底及伙伴同步后的项目自动派发。明确开启后台恢复时使用当前环境存储；日常行为及管理／执行权限不增加。

本轮最终完整离线回归为 213 文件／1672 通过／2 既有 TODO；另有真实 Electron 窄范围并行、renderer-only 及 mock 合同检查。没有新产品候选、安装升级、真实 API／CLI 会员服务或外部宿主人工验收。详见 [S5 审计](../../development-data-isolation-s5.md)。

## 历史阶段记录

通用自动化的当前代码入口、测试和权限边界见以上元数据。

外部宿主定时派发仍需独立 Adapter 与真实联调。

本条绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。

## 2026-11-02 S1 未提交源码增量

本轮源码非日常启动默认不启动计划调度，也不由 writer availability 事件触发自动扫描；日记、记忆兜底及同步伙伴后的项目自动派发同样不自动恢复。显式启动开关可启用本次后台恢复，日常行为不变；管理及执行权限没有增加。

lastVerifiedCommit 保留原已提交基线，不代表本轮未提交实现已绑定。仅完成启动隔离与最小并行核验，不继承旧候选验收；结果与后续停点见 [S1 记录](../../development-data-isolation-s1.md)。
