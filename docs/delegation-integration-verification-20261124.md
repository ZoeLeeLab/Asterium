# 委派整合核验（2026-11-24）

仅在第 13 号委派权限工作树、分支 `codex/feat-delegation-access-20261123` 完成整合。未新建工作树，未推送、合入 main、打包或清理现有工作树。

## 提交与基线

| 内容 | 提交 |
| --- | --- |
| 原干净提交的安全锚点 | `safety/delegation-b35a236-before-main-20261124` → `b35a2363037be261713ef4f4d683810145895e1d` |
| 对齐第八阶段 main | `d3cdb1a72688707aba9dcc4ab565516978abc9b6` |
| 回传、持久送达、写租约及工具重绑 | `9f153962989258bbdf8d02a45265488bda705abc` |
| 内部消息在历史、搜索及定位中隐藏 | `6d0e282745250cb543f3a2592b7375c283c35ebf` |
| 组合回归及现状断言补齐 | `d03e3bfaf89eab4ffcbc268d4c69d11ed2168361` |

远端分支共享状态查询因网络错误未能确认，因此保留已有历史，以 merge 对齐指定的 `a31764339c4febc0e63184fcd732890dd573c909`，没有执行 rebase。基线合并无文本冲突；迁入旧回传提交时按当前 Service／IPC 边界处理冲突，未直接覆盖旧 `agentIpc.ts`，未照搬第 12 号未提交内容。

额外修正了工具配置的竞态：复用的本地适配器在排队期间不提前替换工具或工作区根，取得本轮写租约后再配置。删除协调改为异步取消回传回调，保留现有业务模块。

第八阶段的 `ExistingThreadService.ts`、`existingThreadIpc.ts`、`studioWakeIpc.ts` 及严格 v1 `existingPartnerReview.ts` 与指定 main 完全一致。未改界面布局、测试配置、默认测试命令或超时；此前卡顿修复保留。

## 检查

- 对齐后委派及第八阶段定向测试：8 个文件、59 项通过，含 read/write 提示与严格 v1 请求格式。
- 回传组定向测试：12 个文件、102 项通过；隐藏组：5 个文件、89 项通过。
- Windows 组合回归：9 个文件、121 项通过，串联运行协调器、Codex 适配器、队列、真实聊天存储、重启恢复及三个历史读取入口；原生 RPC 使用合成传输。
- 补齐回归及现状断言：5 个文件、56 项通过，包含默认 API 写租约行为和原线程导入。
- 默认全量：`npm test` 通过 293 个文件、2109 项，保留 1 项既有跳过、2 项既有 TODO；耗时 192.03 秒。
- Typecheck 通过；Lint 0 错误、15 条既有 `PrototypeProvider.tsx` 警告。
- Windows 官方 Claude CLI + 本地合成模型：19 项全部通过。覆盖原通道的读写审批、拒绝、取消和故障处理；没有使用私人配置或真实模型。
- 正式能力检查 16 条通过；工作区和暂存区隐私扫描各 914 个文件、0 项发现；`git diff --check` 通过，不放宽或跳过检查器。

默认全量退出码为 0，退出阶段曾提示一个 fork worker 终止超时。对应 `bridgeCursorStore.test.ts` 单独复核 1 项通过且正常退出，未发现遗留测试子进程；该告警保留在原始全量日志，不当作产品功能失败或抹除。

原始命令、退出码与日志分别保存在工作树忽略的 `.qa/integration-20261124/` 中。Windows CLI 的合成运行记录独立保留。过程中的加载超时、轮询夹具超时、旧断言、过长临时路径和仓库内夹具目录问题均保留原始失败证据；仅最终通过的运行作为结论。

默认全量使用 `npm test`，不传测试筛选、worker 或超时参数。仅限制本次测试进程使用 4 个 CPU 核心，并将合成临时数据放在仓库外独立目录，避免 Windows 资源争用、路径过长及 Git 父仓库识别干扰。日常应用、全局 Git 配置和其他工作树未因此修改。

## 重点覆盖

| 要求 | 验证范围 |
| --- | --- |
| 原对话主动回传 | Main 捕获的原绑定、代次、线程和工作区；普通伙伴回复落盘；配置恢复后补送 |
| 跨轮读取 | 同伙伴／同单聊的后续轮次、两分钟之后仍可读；其他来源拒绝 |
| 重启不重发 | pending 可补送；starting／accepted 转为 uncertain／interrupted；completed 不重放；外部复核只查询原 ID |
| 用户消息优先 | 中止自动汇报、前台消费去重、租约竞争、后续用户工具恢复；删除取消失败不继续清理 |
| 内部消息隐藏 | 新旧 Codex 历史协议跨页、定位、搜索；重启身份记录；保留回复、工具、后续用户指导及用户引用 |

## 保护现场与限制

第 12、14 号的 HEAD、Git 暂存区哈希、状态、MERGE_HEAD，以及全部跟踪和非忽略未跟踪文件的 SHA-256 与开始时一致。第 12 号核对 943 个文件，第 14 号 959 个文件；第 14 号未完成合并现场继续保留。

源码合成验证不等于真实 Codex／API／服务器联调或安装包验收。本轮按指令停在独立分支，不发布、不自动重放不确定的原生提交。行为说明见[委派回传](delegation-result-delivery.md)和[read/write 提示](delegation-access.md)。

## 本次迁移的产品与测试文件

以下清单以对齐后的 `d3cdb1a` 为比较起点，不将第八阶段主线改动算成本次迁移。

- `src/main/adapters/CodexCliAdapter.ts`
- `src/main/agentIpc.ts`
- `src/main/conversation/ConversationLifecycleService.ts`
- `src/main/conversation/NativeHistoryVisibility.ts`
- `src/main/conversation/SingleChatHistoryStore.ts`
- `src/main/conversation/SingleChatMessageStore.ts`
- `src/main/conversation/singleChatHistoryProjection.ts`
- `src/main/ipc/attachmentIpc.ts`
- `src/main/ipc/nativeSessionIpc.ts`
- `src/main/runtime/DelegationConversationRuntime.ts`
- `src/main/runtime/DelegationResultDelivery.ts`
- `src/main/runtime/PartnerDelegation.ts`
- `src/main/runtime/PartnerRuntimeFactory.ts`
- `src/main/runtime/RunCoordinator.ts`
- `src/renderer/types/domain/conversation.ts`
- `src/shared/singleChatMessages.ts`
- `tests/unit/attachmentIpc.test.ts`
- `tests/unit/codexCliAdapter.test.ts`
- `tests/unit/conversationLifecycleService.test.ts`
- `tests/unit/delegationResultDelivery.test.ts`
- `tests/unit/localRuntimeDetectionIpc.test.ts`
- `tests/unit/nativeHistoryVisibility.test.ts`
- `tests/unit/nativeSessionIpc.test.ts`
- `tests/unit/partnerRuntimeFactory.test.ts`
- `tests/unit/runCoordinator.test.ts`
- `tests/unit/runInteractionIpc.test.ts`
- `tests/unit/singleChatHistoryStore.test.ts`
- `tests/unit/singleChatMessageStore.test.ts`

另同步六份文档：

- `docs/capabilities/entries/runtime-tools.md`
- `docs/delegation-access.md`
- `docs/delegation-result-delivery.md`
- `docs/existing-partner-review-v1.md`
- `docs/partner-delegation-implementation.md`
- `docs/delegation-integration-verification-20261124.md`
