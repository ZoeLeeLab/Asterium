# IPC 领域归并与剩余频道归属

基线：`6af275d`。实施前盘点：主文件直接注册 97 个频道，已拆模块注册 133 个，共 230 个 invoke 频道。本文只规划最终归属，不授权迁移暂缓业务。

## 本轮第一阶段

| 顺序 | 现有文件（均位于 `src/main/ipc/`） | 目标模块 | 频道数 |
| --- | --- | --- | ---: |
| 1 | sessionStatusIpc.ts、sessionMaintenanceIpc.ts | sessionIpc.ts | 3 |
| 2 | memoryFallbackModelListIpc.ts、memoryFallbackSettingsIpc.ts | memoryFallbackIpc.ts | 4 |
| 3 | projectFileOpenIpc.ts、projectFileQueryIpc.ts | projectFilesIpc.ts | 3 |
| 4 | projectWorkflowQueryIpc.ts、projectWorkflowTemplateIpc.ts | projectWorkflowIpc.ts | 5 |
| 5 | partnerProfileRefreshIpc.ts、userProfileIpc.ts、profileDirectoryIpc.ts | profileIpc.ts | 3 |

每组独立本地提交。保留现有注册函数及主文件调用位置，以维持跨模块的注册顺序；一个领域模块可以有多个具名注册函数，不增加通用注册框架或转发壳文件。频道、权限、参数、返回值、服务调用及统一退出清理均保持原样。

测试沿用已有场景与隔离夹具，按业务分组运行；不为合并测试文件重写夹具。每组先跑现状测试，迁移后重复定向测试、默认全量回归及提交前检查，全部通过再提交。第二阶段与前端另行处理。

## 剩余 97 个频道：最终模块边界

第一阶段五组与第二阶段四组已经完成并合入主分支。后续按以下修正版分阶段推进；第三阶段已完成工作流生成、工作流草稿与激活两组；第四阶段已完成并验收合并；第五阶段按表推进，其余阶段尚未开始。新模块必须具备完整领域边界；不再按迁移批次另造临时文件。

| 阶段 | 实施顺序 | 入口数 | 阶段结束后主文件剩余 | 当前状态 |
| --- | --- | ---: | ---: | --- |
| 三 | 工作流生成 → 工作流草稿与激活 | 8 | 89 | 源码两组已完成；累计 Windows 验收结果独立留档 |
| 四 | 存储位置 → 项目生命周期 → 工作区创建 | 16 | 73 | 源码三组已完成；累计 Windows 验收结果独立留档 |
| 五 | 伙伴资料 → API 会话删除 → 原生会话 | 13 | 60 | 源码三组已完成；累计 Windows 验收结果独立留档 |
| 六 | 任务执行 → 工作室轮次 → 消息运行 | 16 | 44 | 源码三组已完成；累计 Windows 验收结果独立留档 |
| 七 A | 聊天附件 | 18 | 26 | 源码迁移完成；累计 Windows 实机验收结果独立留档 |
| 七 B | 单聊历史 → 项目文件删除 → 房间删除与上传重试 | 15 | 11 | 源码三组已完成；累计全量与 Windows 验收独立留档 |
| 八 | Wake → CyberBoss | 11 | 0 | 未开始 |

每组先补现状测试、原样迁移，默认全量与静态检查通过后独立本地提交。需要先整理 Service 的组，将服务协调抽取与 IPC 迁移分开提交；不改变数据格式、路径、界面、Preload、频道字符串、业务规则、调用顺序或退出清理。每阶段完成后做累计 Windows 实机冒烟并停下汇报。推送、合并与打包另行授权。

IPC 只接请求、校验权限和参数、调用服务、返回结果。文件业务与业务状态留在原服务。复杂编排先确定服务归属，单独评审；领域归并不顺带重写业务。主文件最终只构造服务、注入依赖、注册模块和统一清理。

| 最终模块（均位于 `src/main/ipc/`） | 本表频道数 | 领域边界与依赖要求 |
| --- | ---: | --- |
| `storageIpc.ts` | 5 | 存储位置；保留切换确认、重启和目录选择生命周期 |
| `projectIpc.ts` | 10 | 项目生命周期、成员与执行策略；共享 ProjectService 与项目协调器 |
| `projectWorkflowIpc.ts` | 4 | 加入本轮工作流模块；保留草稿、版本检查和激活语义 |
| `projectWorkflowGenerationIpc.ts` | 4 | 独立生成任务、运行槽位、取消与重试生命周期 |
| `projectTaskExecutionIpc.ts` | 7 | 独立任务状态机、执行权限、审批与恢复生命周期 |
| `projectWorkspaceIpc.ts` | 1 | 加入已有工作区查询和打开模块；保留位置选择授权 |
| `projectFilesIpc.ts` | 2 | 加入本轮项目文件模块；删除仍由 ProjectFileDeletionService 执行 |
| `studioRoomIpc.ts` | 2 | 加入已有房间管理模块；保留项目协调和上传归档服务 |
| `studioRoundIpc.ts` | 4 | 同一轮次的开始、取消、准备与失败；依赖 StudioOrchestrator |
| `studioWakeIpc.ts` | 3 | 远端 Wake 配置与控制；独立控制器和退出清理 |
| `nativeSessionIpc.ts` | 9 | 原生绑定、导入、目录授权、历史读取与线程生命周期；协调 NativeSessionBindingStore 等既有服务 |
| `attachmentIpc.ts` | 18 | 附件暂存、提交、访问与清理；业务留在附件服务，保留引用生命周期 |
| `conversationHistoryIpc.ts` | 11 | 单聊历史读写、删除与快照维护；保留写入顺序、删除标记和索引生命周期 |
| `profileIpc.ts` | 3 | 加入本轮资料模块；先将跨服务同步编排归入资料服务再迁移 |
| `sessionIpc.ts` | 1 | 加入本轮会话管理模块；保留单会话与整伙伴两条删除分支，不增加现实现没有的运行中检查 |
| `runInteractionIpc.ts` | 5 | 加入已有运行交互模块；统一运行入口，复用 RunCoordinator、PartnerRuntimeFactory 与 PartnerRuntimePort |
| `existingThreadIpc.ts` | 8 | CyberBoss 桥接凭据、观察与发送；独立远端连接和观察取消生命周期 |

`projectTaskIpc.ts` 继续管理任务定义，执行状态机归入 `projectTaskExecutionIpc.ts`；`projectRunChangesIpc.ts` 继续管理运行改动查询。工作室本机 MCP、扩展客户端和远端 Wake 各自保持原边界。

修正版职责边界：

- `claudeSessionImportIpc.ts` 独立保留，不并入原生会话模块。
- `ProjectLifecycleService` 只承接选址凭证的保存、解析、消费，以及创建和删除的跨服务协调；目录选择弹窗、调用方和参数检查仍在 IPC。成员和执行策略继续由 `ProjectService` 处理。项目创建成功后消费选址凭证；工作区创建按现状在创建前消费，两条路径不得统一。
- `nativeSessionIpc.ts`、`attachmentIpc.ts` 各保持单文件领域边界，文件内使用多个具名注册函数，并保持原注册位置与顺序。原生会话分别复用既有绑定、导入、历史与生命周期能力，不新建包揽这些职责的大 Service。窗口级选择与搜索取消状态保持原隔离范围。
- `conversationHistoryIpc.ts` 保留全部历史频道的归属。会话删除中的摘要取消、写入租约、委派清理、日记与记忆刷新归入生命周期协调服务，保留原等待、失败传播和租约释放顺序；IPC 只校验并调用。
- 运行时引用、共享状态、通知和清理的所有者保持单一。服务尚未就绪时仍保留原拒绝行为，不把注册时读取的空引用固定下来。最后单独收尾主文件中的业务辅助函数，不将其堆进通用 Agent Service。

## 逐频道归属表

按照基线主文件的注册顺序列出，始终保留完整 97 行。当前注册位置随迁移更新；契约测试同时核对实际所属文件、频道字符串、主文件剩余入口顺序，以及全部 230 个 invoke 频道各注册一次，不通过删表或减少断言放行。

| 频道标识 | 实际频道 | 最终业务模块 | 当前注册位置 |
| --- | --- | --- | --- |
| `storageGet` | `asterium:storage:get` | `storageIpc.ts` | `storageIpc.ts` |
| `storageChooseUserDataDirectory` | `asterium:storage:choose-user-data-directory` | `storageIpc.ts` | `storageIpc.ts` |
| `storageChooseProjectRoot` | `asterium:storage:choose-project-root` | `storageIpc.ts` | `storageIpc.ts` |
| `storageResetProjectRoot` | `asterium:storage:reset-project-root` | `storageIpc.ts` | `storageIpc.ts` |
| `storageOpenProjectRoot` | `asterium:storage:open-project-root` | `storageIpc.ts` | `storageIpc.ts` |
| `projectChooseLocation` | `asterium:project:choose-location` | `projectIpc.ts` | `projectIpc.ts` |
| `projectDomainInitialize` | `asterium:project-domain:initialize` | `projectIpc.ts` | `projectIpc.ts` |
| `projectPreviewCreateLocation` | `asterium:project:preview-create-location` | `projectIpc.ts` | `projectIpc.ts` |
| `projectCreate` | `asterium:project:create` | `projectIpc.ts` | `projectIpc.ts` |
| `projectUpdate` | `asterium:project:update` | `projectIpc.ts` | `projectIpc.ts` |
| `projectWorkflowCreate` | `asterium:project-workflow:create` | `projectWorkflowIpc.ts` | `projectWorkflowIpc.ts` |
| `projectWorkflowUpdate` | `asterium:project-workflow:update` | `projectWorkflowIpc.ts` | `projectWorkflowIpc.ts` |
| `projectWorkflowRemove` | `asterium:project-workflow:remove` | `projectWorkflowIpc.ts` | `projectWorkflowIpc.ts` |
| `projectWorkflowActivate` | `asterium:project-workflow:activate` | `projectWorkflowIpc.ts` | `projectWorkflowIpc.ts` |
| `projectWorkflowGenerationList` | `asterium:project-workflow-generation:list` | `projectWorkflowGenerationIpc.ts` | `projectWorkflowGenerationIpc.ts` |
| `projectWorkflowGenerationStart` | `asterium:project-workflow-generation:start` | `projectWorkflowGenerationIpc.ts` | `projectWorkflowGenerationIpc.ts` |
| `projectWorkflowGenerationCancel` | `asterium:project-workflow-generation:cancel` | `projectWorkflowGenerationIpc.ts` | `projectWorkflowGenerationIpc.ts` |
| `projectWorkflowGenerationRetry` | `asterium:project-workflow-generation:retry` | `projectWorkflowGenerationIpc.ts` | `projectWorkflowGenerationIpc.ts` |
| `projectTaskExecutionGet` | `asterium:project-task-execution:get` | `projectTaskExecutionIpc.ts` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionEnqueue` | `asterium:project-task-execution:enqueue` | `projectTaskExecutionIpc.ts` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionPause` | `asterium:project-task-execution:pause` | `projectTaskExecutionIpc.ts` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionResume` | `asterium:project-task-execution:resume` | `projectTaskExecutionIpc.ts` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionCancel` | `asterium:project-task-execution:cancel` | `projectTaskExecutionIpc.ts` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionRetry` | `asterium:project-task-execution:retry` | `projectTaskExecutionIpc.ts` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionResolve` | `asterium:project-task-execution:resolve` | `projectTaskExecutionIpc.ts` | `projectTaskExecutionIpc.ts` |
| `projectCreateWorkspace` | `asterium:project:create-workspace` | `projectWorkspaceIpc.ts` | `projectWorkspaceIpc.ts` |
| `projectInspectFileDeletion` | `asterium:project:inspect-file-deletion` | `projectFilesIpc.ts` | `projectFilesIpc.ts` |
| `projectDeleteFile` | `asterium:project:delete-file` | `projectFilesIpc.ts` | `projectFilesIpc.ts` |
| `projectGetExecutionPolicy` | `asterium:project:get-execution-policy` | `projectIpc.ts` | `projectIpc.ts` |
| `projectSetExecutionPolicy` | `asterium:project:set-execution-policy` | `projectIpc.ts` | `projectIpc.ts` |
| `projectSyncMembers` | `asterium:project:sync-members` | `projectIpc.ts` | `projectIpc.ts` |
| `projectChangeMembers` | `asterium:project:change-members` | `projectIpc.ts` | `projectIpc.ts` |
| `projectRemove` | `asterium:project:remove` | `projectIpc.ts` | `projectIpc.ts` |
| `studioRetryProjectUploads` | `asterium:studio:retry-project-uploads` | `studioRoomIpc.ts` | `studioRoomIpc.ts` |
| `studioRemoveRoom` | `asterium:studio:remove-room` | `studioRoomIpc.ts` | `studioRoomIpc.ts` |
| `studioCancelRound` | `asterium:studio:cancel-round` | `studioRoundIpc.ts` | `studioRoundIpc.ts` |
| `studioWakeStatus` | `asterium:studio-wake:status` | `studioWakeIpc.ts` | `agentIpc.ts` |
| `studioWakeConfigure` | `asterium:studio-wake:configure` | `studioWakeIpc.ts` | `agentIpc.ts` |
| `studioWakeControl` | `asterium:studio-wake:control` | `studioWakeIpc.ts` | `agentIpc.ts` |
| `studioStartRound` | `asterium:studio:start-round` | `studioRoundIpc.ts` | `studioRoundIpc.ts` |
| `studioPrepareTurn` | `asterium:studio:prepare-turn` | `studioRoundIpc.ts` | `studioRoundIpc.ts` |
| `studioFailTurn` | `asterium:studio:fail-turn` | `studioRoundIpc.ts` | `studioRoundIpc.ts` |
| `nativeSyncSingleBindings` | `asterium:native-bindings:sync-single` | `nativeSessionIpc.ts` | `nativeSessionIpc.ts` |
| `attachmentChoose` | `asterium:attachment:choose` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentStageFiles` | `asterium:attachment:stage-files` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentPasteFiles` | `asterium:attachment:paste-files` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentStageClipboardImage` | `asterium:attachment:stage-clipboard-image` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentDiscard` | `asterium:attachment:discard` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentCommit` | `asterium:attachment:commit` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentList` | `asterium:attachment:list` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentInspect` | `asterium:attachment:inspect` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentRead` | `asterium:attachment:read` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentOpen` | `asterium:attachment:open` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentReveal` | `asterium:attachment:reveal` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentCopyPath` | `asterium:attachment:copy-path` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentExportAs` | `asterium:attachment:export-as` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentSaveToProject` | `asterium:attachment:save-to-project` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentThumbnail` | `asterium:attachment:thumbnail` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentDeleteConversation` | `asterium:attachment:delete-conversation` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentPreviewSnapshotCleanup` | `asterium:attachment:preview-snapshot-cleanup` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `attachmentClearSnapshots` | `asterium:attachment:clear-snapshots` | `attachmentIpc.ts` | `attachmentIpc.ts` |
| `conversationDelete` | `asterium:conversation:delete` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `conversationListDeleted` | `asterium:conversation:list-deleted` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `conversationOpenHistory` | `asterium:conversation:open-history` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `conversationPreviewSnapshotCleanup` | `asterium:conversation:preview-snapshot-cleanup` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `conversationClearSnapshots` | `asterium:conversation:clear-snapshots` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `conversationMigrateHistory` | `asterium:conversation:migrate-history` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `conversationReadHistoryPage` | `asterium:conversation:read-history-page` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `conversationReadToolOutput` | `asterium:conversation:read-tool-output` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `conversationSearchHistory` | `asterium:conversation:search-history` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `conversationWriteHistory` | `asterium:conversation:write-history` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `conversationSyncMessages` | `asterium:conversation:sync-messages` | `conversationHistoryIpc.ts` | `conversationHistoryIpc.ts` |
| `chooseCodexThreadDirectory` | `asterium:agent:choose-codex-thread-directory` | `nativeSessionIpc.ts` | `nativeSessionIpc.ts` |
| `confirmCodexThreadImport` | `asterium:agent:confirm-codex-thread-import` | `nativeSessionIpc.ts` | `nativeSessionIpc.ts` |
| `codexImportedWorkspaceStatus` | `asterium:agent:codex-imported-workspace-status` | `nativeSessionIpc.ts` | `nativeSessionIpc.ts` |
| `chooseCodexImportedDirectory` | `asterium:agent:choose-codex-imported-directory` | `nativeSessionIpc.ts` | `nativeSessionIpc.ts` |
| `readCodexHistory` | `asterium:agent:read-codex-history` | `nativeSessionIpc.ts` | `nativeSessionIpc.ts` |
| `searchCodexHistory` | `asterium:agent:search-codex-history` | `nativeSessionIpc.ts` | `nativeSessionIpc.ts` |
| `getLocalThreadLifecycles` | `asterium:agent:get-local-thread-lifecycles` | `nativeSessionIpc.ts` | `nativeSessionIpc.ts` |
| `changeLocalThreadLifecycle` | `asterium:agent:change-local-thread-lifecycle` | `nativeSessionIpc.ts` | `nativeSessionIpc.ts` |
| `syncPartnerProfiles` | `asterium:agent:sync-partner-profiles` | `profileIpc.ts` | `profileIpc.ts` |
| `savePartnerProfile` | `asterium:agent:save-partner-profile` | `profileIpc.ts` | `profileIpc.ts` |
| `trashPartnerProfile` | `asterium:agent:trash-partner-profile` | `profileIpc.ts` | `profileIpc.ts` |
| `deleteApiSession` | `asterium:agent:delete-api-session` | `sessionIpc.ts` | `sessionIpc.ts` |
| `sendApiMessage` | `asterium:agent:send-api-message` | `runInteractionIpc.ts` | `runInteractionIpc.ts` |
| `saveBridgeCredential` | `asterium:agent:save-bridge-credential` | `existingThreadIpc.ts` | `agentIpc.ts` |
| `bridgeCredentialStatus` | `asterium:agent:bridge-credential-status` | `existingThreadIpc.ts` | `agentIpc.ts` |
| `deleteBridgeCredential` | `asterium:agent:delete-bridge-credential` | `existingThreadIpc.ts` | `agentIpc.ts` |
| `testExistingThread` | `asterium:agent:test-existing-thread` | `existingThreadIpc.ts` | `agentIpc.ts` |
| `watchExistingThread` | `asterium:agent:watch-existing-thread` | `existingThreadIpc.ts` | `agentIpc.ts` |
| `stopExistingThreadWatch` | `asterium:agent:stop-existing-thread-watch` | `existingThreadIpc.ts` | `agentIpc.ts` |
| `getExistingThreadFileCapabilities` | `asterium:agent:existing-thread-file-capabilities` | `existingThreadIpc.ts` | `agentIpc.ts` |
| `sendExistingThreadMessage` | `asterium:agent:send-existing-thread-message` | `existingThreadIpc.ts` | `agentIpc.ts` |
| `sendMessage` | `asterium:agent:send-message` | `runInteractionIpc.ts` | `runInteractionIpc.ts` |
| `cancelRun` | `asterium:agent:cancel-run` | `runInteractionIpc.ts` | `runInteractionIpc.ts` |
| `resolveAuthorization` | `asterium:agent:resolve-authorization` | `runInteractionIpc.ts` | `runInteractionIpc.ts` |
| `resumeSession` | `asterium:agent:resume-session` | `runInteractionIpc.ts` | `runInteractionIpc.ts` |
