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
    "src/main/adapters/ClaudeCodeAdapter.ts",
    "src/main/security/ConversationAttachmentStore.ts",
    "src/main/runtime/PartnerRuntimePort.ts",
    "src/main/studio/StudioAttachments.ts",
    "src/main/runtime/PartnerDelegation.ts",
    "src/main/runtime/ExistingPartnerReview.ts",
    "src/main/adapters/CyberBossBridgeClient.ts",
    "src/main/agentIpc.ts",
    "src/shared/existingPartnerReview.ts"
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
    "tests/claude-cli-acceptance.mjs",
    "tests/unit/studioAttachments.test.ts",
    "tests/unit/partnerRuntimePort.test.ts",
    "tests/unit/existingPartnerReview.test.ts",
    "tests/renderer/ExistingPartnerReview.test.tsx"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/release-status.md",
    "docs/claude-cli-compatibility.md",
    "docs/studio-attachments.md",
    "docs/existing-partner-review-v1.md"
  ],
  "lastVerifiedCommit": "a8c1a7838c732fa834d23cc463dff39d393f44cb"
}
---

运行状态、项目与协作工具的当前代码入口、测试和权限边界见以上元数据。

Claude 运行通道改为官方 CLI 与 stdio MCP；复用既有记忆、笔记、任务与协作工具，不另建业务服务。资料重读、恢复及压缩保留原服务与合成测试；官方 CLI 的主审批、取消、断连等有单独 Windows 本地合成验证，完整真实协作仍待验收。

此前关于页阶段核验绑定已存在代码提交 `2b084045c0f923bba54127d0cb3366a730df55f5`，不继承旧候选验收归属。构建和人工验收分别以新候选独立报告为准；模拟、源码及配置核验不代表真实服务或普通账户验收通过。

官方 CLI 合成回归还覆盖明确 session ID 恢复及部分流事件；不等于真实订阅已验收。

Full 原生命令使用经用户授权的当前 Windows 账户权限；路径检查和受管资料服务不构成任意命令的操作系统级隔离。主审批、只读及取消约束继续生效。

CLI 子进程单独关闭后台自更新，不更改用户全局设置，仍由用户维护官方版本；真实订阅验收独立记录。


## 首版补齐阶段

本轮将群聊用户附件交给既有本地/API 运行通道，conversation_files 的附件列表按 Main 当前绑定的群聊及输入边界提供。单轮原生/多模态输入最多附带上下文中最近 10 个唯一附件，公开历史与查询仍保留附件引用。工具、审批与会话格式继续沿用，不增加模型权限；具体文件理解与真实协作待新候选验收。

首版补齐阶段曾绑定代码提交 `a4a5ace1446b0a2601099cae337c21fbb56a8fb8`，此前来源 `2b084045c0f923bba54127d0cb3366a730df55f5` 保留在历史中。全套检查及新包验收结果另见独立候选报告。

## 伙伴委派

单聊委派工具、持久队列、结果与取消入口见 [阶段核验](../../partner-delegation-implementation.md)。本地 Codex 可作为执行伙伴接收文本和指定图片。该入口使用宿主读取权限，任务目录外的强制拒读仍待验收。

接回伙伴的 Markdown 复核增加了星丛侧客户端与模拟验收。启用需宿主声明 v1 能力并匹配已绑定原线程。单次只发送一份 Markdown 文件及简短转交说明，回执回到发起单聊任务卡。附件文件不内联到任务消息正文。普通单聊附件、图片和其他文件格式仍不在此能力范围内。Sidecar 由宿主侧接线，实际部署单独验收。详见 [接回伙伴复核契约](../../existing-partner-review-v1.md)。

本条结构化 SHA 绑定已存在的 Markdown 复核代码提交 `a8c1a7838c732fa834d23cc463dff39d393f44cb`。仓库内验证覆盖模拟宿主的文件上传、同 ID 恢复查询、忙碌重试和界面回卡，实际连接与验收原件在私有环境留存。

单聊任务卡跟在发起委派的伙伴气泡中对应的「派出小弟」记录之后。任务详情默认折叠。无法确定对应记录时，卡片在原轮气泡顶部显示。后台返回的结果仍更新原轮的卡片。
