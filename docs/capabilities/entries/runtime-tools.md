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
    "src/main/runtime/DelegationAccess.ts",
    "src/main/runtime/DelegationConversationRuntime.ts",
    "src/main/runtime/DelegationResultDelivery.ts",
    "src/main/runtime/RunCoordinator.ts",
    "src/main/runtime/PartnerRuntimeFactory.ts",
    "src/main/conversation/ConversationLifecycleService.ts",
    "src/main/conversation/NativeHistoryVisibility.ts",
    "src/main/conversation/SingleChatHistoryStore.ts",
    "src/main/conversation/SingleChatMessageStore.ts",
    "src/main/ipc/attachmentIpc.ts",
    "src/main/ipc/nativeSessionIpc.ts",
    "src/main/adapters/CodexCliAdapter.ts",
    "src/shared/delegationAccess.ts",
    "src/main/runtime/ExistingPartnerReview.ts",
    "src/main/adapters/CyberBossBridgeClient.ts",
    "src/main/agentIpc.ts",
    "src/shared/existingPartnerReview.ts",
    "src/main/runtime/LocalRuntimeResolver.ts",
    "src/main/runtime/MessageRuntime.ts",
    "src/main/runtime/LegacyRunPath.ts",
    "src/main/runtime/RuntimeEventBridge.ts",
    "src/main/runtime/RuntimeRunHooks.ts",
    "src/main/runtime/RuntimeToolBindings.ts",
    "src/main/runtime/DelegationExecutor.ts",
    "src/main/runtime/DelegationToolHandler.ts",
    "src/main/runtime/SessionMaintenanceRuntime.ts",
    "src/main/runtime/ExistingThreadService.ts",
    "src/main/studio/StudioTurnRuntime.ts"
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
    "tests/unit/delegationAccess.test.ts",
    "tests/unit/partnerDelegation.test.ts",
    "tests/unit/delegationResultDelivery.test.ts",
    "tests/unit/delegationIpc.test.ts",
    "tests/unit/nativeHistoryVisibility.test.ts",
    "tests/unit/nativeSessionIpc.test.ts",
    "tests/unit/codexCliAdapter.test.ts",
    "tests/unit/localRuntimeDetectionIpc.test.ts",
    "tests/unit/partnerRuntimeFactory.test.ts",
    "tests/unit/runCoordinator.test.ts",
    "tests/unit/runInteractionIpc.test.ts",
    "tests/unit/attachmentIpc.test.ts",
    "tests/unit/conversationLifecycleService.test.ts",
    "tests/unit/singleChatHistoryStore.test.ts",
    "tests/unit/singleChatMessageStore.test.ts",
    "tests/renderer/Phase6RunHistoryIntegration.test.tsx",
    "tests/renderer/ExistingPartnerReview.test.tsx",
    "tests/unit/localRuntimeResolver.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/release-status.md",
    "docs/claude-cli-compatibility.md",
    "docs/studio-attachments.md",
    "docs/existing-partner-review-v1.md",
    "docs/delegation-access.md",
    "docs/delegation-result-delivery.md",
    "docs/delegation-integration-verification-20261124.md",
    "docs/agent-ipc-final-service-extraction.md",
    "docs/agent-ipc-final-service-granularity.md",
    "docs/agent-ipc-final-service-verification-20261124.md"
  ],
  "lastVerifiedCommit": "4ed57df4cab29444a48ad9f8b128e1dbc0ad5045"
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

## 聊天操作记录

聊天时间线按连续操作分段。每段有四条以上操作，或恰好三条同类操作时，默认折叠并按用途显示次数，进行中和失败数量显示在摘要上。展开后可按发生顺序查看明细。授权、追问、独立文件交付和委派回执各自显示。

## 伙伴委派

2026-11-23 独立工作树增量：发起伙伴选择 read/write；接回伙伴继续使用原 v1 接口，仅在 message 中追加“本次只读”或“本次可按授权执行”的要求，不新增 HTTP 权限字段或接收端升级要求。read 依赖模型遵守提示词，不代表服务器强制沙箱隔离；实际执行和审批仍沿用接收端原有配置。星丛保留只读／Plan 不可发起 write、排队前复查及未知回执只查原 ID 的处理。普通本地/API 一次性委派仍只读，旧原生线程工具清单不自动升级。此前未发布的 v2 草案已撤回。设计与分阶段验证见[委派任务说明](../../delegation-access.md)。提示词方案历史代码为 `6889c9e1849e1fb65f0c1fe7f534184f9b070bc5`；当前整合绑定见上方 lastVerifiedCommit，不代表已发布。

单聊委派工具、持久队列、结果与取消入口见 [阶段核验](../../partner-delegation-implementation.md)。本地 Codex 可作为执行伙伴接收文本和指定图片。该入口使用宿主读取权限，任务目录外的强制拒读仍待验收。

接回伙伴的 Markdown 复核增加了星丛侧客户端与模拟验收。启用需宿主声明 v1 能力并匹配已绑定原线程。单次只发送一份 Markdown 文件及简短转交说明，回执回到发起单聊任务卡。附件文件不内联到任务消息正文。普通单聊附件、图片和其他文件格式仍不在此能力范围内。Sidecar 由宿主侧接线，实际部署单独验收。详见 [接回伙伴复核契约](../../existing-partner-review-v1.md)。

Markdown 复核阶段的代码提交为 `a8c1a7838c732fa834d23cc463dff39d393f44cb`。该阶段仓库内验证覆盖模拟宿主的文件上传、同 ID 恢复查询、忙碌重试和界面回卡，实际连接与验收原件在私有环境留存；本轮结构化 SHA 与验证范围见上方源码增量和委派任务权限记录。

单聊任务卡跟在发起委派的伙伴气泡中对应的「派出小弟」记录之后。任务详情默认折叠。无法确定对应记录时，卡片在原轮气泡顶部显示。后台返回的结果仍更新原轮的卡片。

2026-11-24 整合第八阶段模块边界后，Main 持久记录原会话投递目标，在原单聊空闲时续用原线程主动汇报。同一单聊和发起伙伴可跨轮读取结果；前台消费正常完成后不重复后台汇报。用户消息优先，后台运行只尝试获取现有写租约，并在租约内复查绑定、重绑本轮工具；排队用户不会提前替换正在汇报的配置。

内部输入按 Main 的确切消息／运行身份隐藏于 Codex 原生历史分页、搜索和定位，保留伙伴回复、工具及真实用户输入。重启仅补送尚未开始的结果；已接受或无法确定的提交不会盲目重发。read/write 仍为原 v1 message 的任务提示，不要求服务器升级。数据流、限制和合成验收边界见[原会话回传说明](../../delegation-result-delivery.md)。此前委派整合阶段的核验绑定已存在代码基线 `d03e3bfaf89eab4ffcbc268d4c69d11ed2168361`，在后续纯文档提交记录[核验](../../delegation-integration-verification-20261124.md)，不沿用旧候选验收归属。

最终业务辅助逻辑收尾的源码与合成回归核验绑定 `4ed57df4cab29444a48ad9f8b128e1dbc0ad5045`。模块归属与颗粒度审查见新增文档；既有工具、权限、协议和界面行为保持不变。该核验不扩展真实服务验收范围。
