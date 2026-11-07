---
{
  "name": "工作室与群聊",
  "id": "asterium.studio",
  "appliesTo": [
    "api",
    "local_cli",
    "existing_thread"
  ],
  "protocols": [
    "internal"
  ],
  "permissionBoundary": "群公开消息可见性由成员关系决定；内部调度与公开消息落账分离。",
  "status": "stable",
  "codeEntries": [
    "src/main/studio/StudioRoomStore.ts",
    "src/main/studio/StudioOrchestrator.ts",
    "src/shared/studioRuntime.ts",
    "src/shared/studioHistory.ts",
    "src/main/studio/StudioAttachments.ts",
    "src/main/runtime/PartnerRuntimePort.ts",
    "src/renderer/components/studio/StudioComposer.tsx",
    "src/renderer/components/chat/MessageAttachmentCards.tsx",
    "src/renderer/pages/StudioPage.tsx",
    "src/main/project/ProjectWorkspaceStore.ts",
    "src/main/agentIpc.ts",
    "src/renderer/components/studio/ProjectFileTree.tsx"
  ],
  "tests": [
    "tests/unit/studioRoomStore.test.ts",
    "tests/renderer/NavigationFlows.test.tsx",
    "tests/unit/studioOrchestrator.test.ts",
    "tests/unit/studioAttachments.test.ts",
    "tests/unit/partnerRuntimePort.test.ts",
    "tests/renderer/StudioComposer.test.tsx",
    "tests/unit/projectWorkspaceStore.test.ts",
    "tests/renderer/StorageSettings.test.tsx",
    "tests/unit/projectBrowserService.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/release-status.md",
    "docs/studio-attachments.md",
    "docs/releases/0.1.0-beta.1-r2.md",
    "docs/data-isolation.md",
    "docs/automatic-test-isolation.md",
    "docs/development-data-isolation-progress.md",
    "docs/development-data-isolation-s5.md"
  ],
  "lastVerifiedCommit": "efeb5445bf93510e2d3871aaee831aadfccad880"
}
---

## 当前源码核验：2026-11-02 S5

本条绑定已存在的代码提交 `89a6c2dfd803b470690f1a2993d8ba729e981dca`；本次为纯文档核验，不使用自身或未来提交号。工作室新建项目显示当前环境配置的默认保存位置，并在实际创建前确认最终完整路径。项目成员、群聊代次、任务与工作区授权语义保持；已有项目不随默认目录变更而搬迁。

本轮最终完整离线回归为 213 文件／1672 通过／2 既有 TODO；另有真实 Electron 窄范围并行、renderer-only 及 mock 合同检查。没有新产品候选、安装升级、真实 API／CLI 会员服务或外部宿主人工验收。详见 [S5 审计](../../development-data-isolation-s5.md)。

## 历史阶段记录

工作室与群聊的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

首次核验曾绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。


## 首版补齐阶段

群聊可选择、拖入或粘贴图片和文件、附文或仅附件发送、保存历史快照、显示与预览卡片；每条最多 10 个、单个 20 MiB。Main 从桌面附件服务的待选 ID 生成元数据，冻结群聊账本序号并绑定当前原生会话的读取范围，复用单聊适配器与文件服务，不改变 CLI 登录或 Full 的 Windows 账户权限。图片和文档理解依伙伴能力；外部现有线程仅收到附件元数据，不收到内容或本机路径。Markdown 导出仅含引用。项目群中的用户附件在消息发布后从快照复制到项目的 `uploads/`；失败保留待补存状态，补存不重发消息。「项目文件交付」展示实际根目录和子目录，沿用原交付登记与上下文注入方式。详见[群聊附件](../../studio-attachments.md)。本轮能力以 `efeb5445bf93510e2d3871aaee831aadfccad880` 为代码基线。相关自动回归使用合成数据；开发版已人工确认拖放、粘贴、项目群附件归档和项目文件交付。合成存储及 UI 测试不等于真实伙伴理解或多人协作通过。

当前 lastVerifiedCommit 绑定已存在代码提交 `a4a5ace1446b0a2601099cae337c21fbb56a8fb8`，之前的真实来源 `39122d3a15ba44f14568d6826b7dc5b590266cea` 仍在历史中保留。全套检查及新包验收结果另见独立候选报告；不继承旧候选验收归属。
