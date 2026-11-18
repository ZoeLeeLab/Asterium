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

以下全部为后续规划，本轮不迁移。涉及此前暂缓的存储、项目编辑、工作流草稿与激活、执行状态、删除、成员、附件、历史、原生会话和 CyberBoss 等业务，继续暂缓。新模块必须具备表中完整领域边界；不再按迁移批次另造临时文件。

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
| `sessionIpc.ts` | 1 | 加入本轮会话管理模块；保持会话删除的运行中检查和绑定处理 |
| `runInteractionIpc.ts` | 5 | 加入已有运行交互模块；统一运行入口，复用 RunCoordinator、PartnerRuntimeFactory 与 PartnerRuntimePort |
| `existingThreadIpc.ts` | 8 | CyberBoss 桥接凭据、观察与发送；独立远端连接和观察取消生命周期 |

`projectTaskIpc.ts` 继续管理任务定义，执行状态机归入 `projectTaskExecutionIpc.ts`；`projectRunChangesIpc.ts` 继续管理运行改动查询。工作室本机 MCP、扩展客户端和远端 Wake 各自保持原边界。原生会话模块承接完整绑定与原生线程访问领域，内部编排依赖服务，避免把线程运行细节搬进 IPC。

## 逐频道归属表

按照基线主文件的注册顺序列出。频道标识与实际频道字符串均与共享定义逐项核对；现有契约测试校验这 97 行无遗漏、无重复。

| 频道标识 | 实际频道 | 最终业务模块 |
| --- | --- | --- |
| `storageGet` | `asterium:storage:get` | `storageIpc.ts` |
| `storageChooseUserDataDirectory` | `asterium:storage:choose-user-data-directory` | `storageIpc.ts` |
| `storageChooseProjectRoot` | `asterium:storage:choose-project-root` | `storageIpc.ts` |
| `storageResetProjectRoot` | `asterium:storage:reset-project-root` | `storageIpc.ts` |
| `storageOpenProjectRoot` | `asterium:storage:open-project-root` | `storageIpc.ts` |
| `projectChooseLocation` | `asterium:project:choose-location` | `projectIpc.ts` |
| `projectDomainInitialize` | `asterium:project-domain:initialize` | `projectIpc.ts` |
| `projectPreviewCreateLocation` | `asterium:project:preview-create-location` | `projectIpc.ts` |
| `projectCreate` | `asterium:project:create` | `projectIpc.ts` |
| `projectUpdate` | `asterium:project:update` | `projectIpc.ts` |
| `projectWorkflowCreate` | `asterium:project-workflow:create` | `projectWorkflowIpc.ts` |
| `projectWorkflowUpdate` | `asterium:project-workflow:update` | `projectWorkflowIpc.ts` |
| `projectWorkflowRemove` | `asterium:project-workflow:remove` | `projectWorkflowIpc.ts` |
| `projectWorkflowActivate` | `asterium:project-workflow:activate` | `projectWorkflowIpc.ts` |
| `projectWorkflowGenerationList` | `asterium:project-workflow-generation:list` | `projectWorkflowGenerationIpc.ts` |
| `projectWorkflowGenerationStart` | `asterium:project-workflow-generation:start` | `projectWorkflowGenerationIpc.ts` |
| `projectWorkflowGenerationCancel` | `asterium:project-workflow-generation:cancel` | `projectWorkflowGenerationIpc.ts` |
| `projectWorkflowGenerationRetry` | `asterium:project-workflow-generation:retry` | `projectWorkflowGenerationIpc.ts` |
| `projectTaskExecutionGet` | `asterium:project-task-execution:get` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionEnqueue` | `asterium:project-task-execution:enqueue` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionPause` | `asterium:project-task-execution:pause` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionResume` | `asterium:project-task-execution:resume` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionCancel` | `asterium:project-task-execution:cancel` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionRetry` | `asterium:project-task-execution:retry` | `projectTaskExecutionIpc.ts` |
| `projectTaskExecutionResolve` | `asterium:project-task-execution:resolve` | `projectTaskExecutionIpc.ts` |
| `projectCreateWorkspace` | `asterium:project:create-workspace` | `projectWorkspaceIpc.ts` |
| `projectInspectFileDeletion` | `asterium:project:inspect-file-deletion` | `projectFilesIpc.ts` |
| `projectDeleteFile` | `asterium:project:delete-file` | `projectFilesIpc.ts` |
| `projectGetExecutionPolicy` | `asterium:project:get-execution-policy` | `projectIpc.ts` |
| `projectSetExecutionPolicy` | `asterium:project:set-execution-policy` | `projectIpc.ts` |
| `projectSyncMembers` | `asterium:project:sync-members` | `projectIpc.ts` |
| `projectChangeMembers` | `asterium:project:change-members` | `projectIpc.ts` |
| `projectRemove` | `asterium:project:remove` | `projectIpc.ts` |
| `studioRetryProjectUploads` | `asterium:studio:retry-project-uploads` | `studioRoomIpc.ts` |
| `studioRemoveRoom` | `asterium:studio:remove-room` | `studioRoomIpc.ts` |
| `studioCancelRound` | `asterium:studio:cancel-round` | `studioRoundIpc.ts` |
| `studioWakeStatus` | `asterium:studio-wake:status` | `studioWakeIpc.ts` |
| `studioWakeConfigure` | `asterium:studio-wake:configure` | `studioWakeIpc.ts` |
| `studioWakeControl` | `asterium:studio-wake:control` | `studioWakeIpc.ts` |
| `studioStartRound` | `asterium:studio:start-round` | `studioRoundIpc.ts` |
| `studioPrepareTurn` | `asterium:studio:prepare-turn` | `studioRoundIpc.ts` |
| `studioFailTurn` | `asterium:studio:fail-turn` | `studioRoundIpc.ts` |
| `nativeSyncSingleBindings` | `asterium:native-bindings:sync-single` | `nativeSessionIpc.ts` |
| `attachmentChoose` | `asterium:attachment:choose` | `attachmentIpc.ts` |
| `attachmentStageFiles` | `asterium:attachment:stage-files` | `attachmentIpc.ts` |
| `attachmentPasteFiles` | `asterium:attachment:paste-files` | `attachmentIpc.ts` |
| `attachmentStageClipboardImage` | `asterium:attachment:stage-clipboard-image` | `attachmentIpc.ts` |
| `attachmentDiscard` | `asterium:attachment:discard` | `attachmentIpc.ts` |
| `attachmentCommit` | `asterium:attachment:commit` | `attachmentIpc.ts` |
| `attachmentList` | `asterium:attachment:list` | `attachmentIpc.ts` |
| `attachmentInspect` | `asterium:attachment:inspect` | `attachmentIpc.ts` |
| `attachmentRead` | `asterium:attachment:read` | `attachmentIpc.ts` |
| `attachmentOpen` | `asterium:attachment:open` | `attachmentIpc.ts` |
| `attachmentReveal` | `asterium:attachment:reveal` | `attachmentIpc.ts` |
| `attachmentCopyPath` | `asterium:attachment:copy-path` | `attachmentIpc.ts` |
| `attachmentExportAs` | `asterium:attachment:export-as` | `attachmentIpc.ts` |
| `attachmentSaveToProject` | `asterium:attachment:save-to-project` | `attachmentIpc.ts` |
| `attachmentThumbnail` | `asterium:attachment:thumbnail` | `attachmentIpc.ts` |
| `attachmentDeleteConversation` | `asterium:attachment:delete-conversation` | `attachmentIpc.ts` |
| `attachmentPreviewSnapshotCleanup` | `asterium:attachment:preview-snapshot-cleanup` | `attachmentIpc.ts` |
| `attachmentClearSnapshots` | `asterium:attachment:clear-snapshots` | `attachmentIpc.ts` |
| `conversationDelete` | `asterium:conversation:delete` | `conversationHistoryIpc.ts` |
| `conversationListDeleted` | `asterium:conversation:list-deleted` | `conversationHistoryIpc.ts` |
| `conversationOpenHistory` | `asterium:conversation:open-history` | `conversationHistoryIpc.ts` |
| `conversationPreviewSnapshotCleanup` | `asterium:conversation:preview-snapshot-cleanup` | `conversationHistoryIpc.ts` |
| `conversationClearSnapshots` | `asterium:conversation:clear-snapshots` | `conversationHistoryIpc.ts` |
| `conversationMigrateHistory` | `asterium:conversation:migrate-history` | `conversationHistoryIpc.ts` |
| `conversationReadHistoryPage` | `asterium:conversation:read-history-page` | `conversationHistoryIpc.ts` |
| `conversationReadToolOutput` | `asterium:conversation:read-tool-output` | `conversationHistoryIpc.ts` |
| `conversationSearchHistory` | `asterium:conversation:search-history` | `conversationHistoryIpc.ts` |
| `conversationWriteHistory` | `asterium:conversation:write-history` | `conversationHistoryIpc.ts` |
| `conversationSyncMessages` | `asterium:conversation:sync-messages` | `conversationHistoryIpc.ts` |
| `chooseCodexThreadDirectory` | `asterium:agent:choose-codex-thread-directory` | `nativeSessionIpc.ts` |
| `confirmCodexThreadImport` | `asterium:agent:confirm-codex-thread-import` | `nativeSessionIpc.ts` |
| `codexImportedWorkspaceStatus` | `asterium:agent:codex-imported-workspace-status` | `nativeSessionIpc.ts` |
| `chooseCodexImportedDirectory` | `asterium:agent:choose-codex-imported-directory` | `nativeSessionIpc.ts` |
| `readCodexHistory` | `asterium:agent:read-codex-history` | `nativeSessionIpc.ts` |
| `searchCodexHistory` | `asterium:agent:search-codex-history` | `nativeSessionIpc.ts` |
| `getLocalThreadLifecycles` | `asterium:agent:get-local-thread-lifecycles` | `nativeSessionIpc.ts` |
| `changeLocalThreadLifecycle` | `asterium:agent:change-local-thread-lifecycle` | `nativeSessionIpc.ts` |
| `syncPartnerProfiles` | `asterium:agent:sync-partner-profiles` | `profileIpc.ts` |
| `savePartnerProfile` | `asterium:agent:save-partner-profile` | `profileIpc.ts` |
| `trashPartnerProfile` | `asterium:agent:trash-partner-profile` | `profileIpc.ts` |
| `deleteApiSession` | `asterium:agent:delete-api-session` | `sessionIpc.ts` |
| `sendApiMessage` | `asterium:agent:send-api-message` | `runInteractionIpc.ts` |
| `saveBridgeCredential` | `asterium:agent:save-bridge-credential` | `existingThreadIpc.ts` |
| `bridgeCredentialStatus` | `asterium:agent:bridge-credential-status` | `existingThreadIpc.ts` |
| `deleteBridgeCredential` | `asterium:agent:delete-bridge-credential` | `existingThreadIpc.ts` |
| `testExistingThread` | `asterium:agent:test-existing-thread` | `existingThreadIpc.ts` |
| `watchExistingThread` | `asterium:agent:watch-existing-thread` | `existingThreadIpc.ts` |
| `stopExistingThreadWatch` | `asterium:agent:stop-existing-thread-watch` | `existingThreadIpc.ts` |
| `getExistingThreadFileCapabilities` | `asterium:agent:existing-thread-file-capabilities` | `existingThreadIpc.ts` |
| `sendExistingThreadMessage` | `asterium:agent:send-existing-thread-message` | `existingThreadIpc.ts` |
| `sendMessage` | `asterium:agent:send-message` | `runInteractionIpc.ts` |
| `cancelRun` | `asterium:agent:cancel-run` | `runInteractionIpc.ts` |
| `resolveAuthorization` | `asterium:agent:resolve-authorization` | `runInteractionIpc.ts` |
| `resumeSession` | `asterium:agent:resume-session` | `runInteractionIpc.ts` |
