# agentIpc 最终业务辅助逻辑收尾验收

日期：2026-11-24。分支：`codex/agent-ipc-final-service-extraction`。复用第 13 号工作树。

起点为 `origin/main eab6b7d7aee207eae28bcae28f6f0514f5d9f331`。最终代码核验基线为已存在提交 `4ed57df4cab29444a48ad9f8b128e1dbc0ad5045`；后续仅追加文档核验，不把文档提交写成自身代码基线。

## 提交与职责

| 提交 | 内容 | 分组验证 |
| --- | --- | --- |
| `4bac698` | 运行时解析、安装缓存、目录／授权与导入线程检查 | 21 项定向；默认全量 2112 项通过，另有 1 项条件跳过、2 项 TODO |
| `f6c4ed8` | API／本地消息启动、事件投递与生命周期；保留旧运行路径 | 45 项定向；默认全量 2114 项通过，另有 1 项条件跳过、2 项 TODO |
| `968aef2` | 委派执行、工具处理、原对话回传装配及笔记工具 | 89 项定向；默认全量 2119 项通过，另有 1 项条件跳过、2 项 TODO |
| `e5aa405` | 会话维护、日记、自动化、工作室及项目领域回调 | 71 项定向；默认全量 2120 项通过、2 项 TODO |
| `4ed57df` | 颗粒度复核，六处归并回现有领域模块，显式标记类型依赖 | 128 项定向；默认全量再次 2120 项通过、2 项 TODO |

主文件保留构造、依赖注入、薄事件连接、领域 IPC 注册和统一清理。新增源码最终为 13 个模块。六处归并结果及每个新增文件的独立理由见 [颗粒度审查](agent-ipc-final-service-granularity.md)。

## 最终代码验证

| 检查 | 结果 |
| --- | --- |
| 默认 `npm test` | 294 个文件通过；2120 项通过、2 项既有 TODO，无跳过项 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 0 错误；15 条既有 Renderer Hook 警告 |
| 能力词典 | 保留 16 个能力条目；代码入口及核验绑定以最终代码提交为准 |
| 隐私 | 工作树、暂存内容和冻结代码分别扫描；公开内容使用合成数据 |
| 原实现比对 | 34 个迁移业务声明、注册调用顺序及统一清理令牌一致；六处归并另比对 10 段业务实现 |
| 类型依赖 | 仅用于注入类型的引用显式标记，转换前后生成 JavaScript 的有效令牌一致 |

默认全量未增加筛选、延长超时或跳过参数，测试配置及 CI 未改。构建本地原生测试辅助程序后，原条件跳过项也已执行。

`ASTERIUM_USE_LEGACY_RUN_PATH=1` 继续选择旧路径，旧运行函数完整保留。Main IPC 回归同时覆盖默认／旧路径的启动、幂等去重、取消与释放。

委派组合回归覆盖：原对话回传、跨轮读取、重启不盲目重发、用户消息优先；read/write 仍使用严格 v1 发送，父只读与 Plan 不能升级权限。历史分页、搜索及定位继续按 Main 记录的内部身份隐藏宿主消息。工具时间线、聚焦同步和既有性能修复未作功能修改。

## 冻结代码的 Windows 累计验收

以下全部在归并后的 `4ed57df4cab29444a48ad9f8b128e1dbc0ad5045` 上重新运行，使用独立资料目录、本地合成模型或合成桥接回包。

| 验收 | 覆盖及结果 |
| --- | --- |
| 累计主流程 | 4 次真实 Electron 启停；90 个业务 IPC 成功路径，另测调用者／参数边界；230 个频道每次各注册、清理一次 |
| 附件与历史 | 文件输入、剪贴板、图片解码、快照版本、导出、项目交付、引用保留；历史分页／搜索／定位、工具正文、迁移备份、删除标记和重启保持 |
| 项目及运行 | 本地合成 Codex stdio、API 流式／取消／审批／恢复、任务执行控制、工作流生成／重试／激活、群聊轮次、房间上传重试与删除 |
| Wake | 2 次真实启停；5 种动作、失败恢复、设置持久化及退出中断 |
| 桥接升级 | 冻结旧模拟应用 → 当前代码 → 当前代码重启；引用、游标、原线程、消息往返及幂等保持 |
| 官方 Claude CLI | 实际 Windows CLI 对本地合成模型；19 个场景全部通过，含审批允许／拒绝、提问、取消、断连及故障钩子 |

这属于源码合成验收，不是安装包验收、真实云端订阅或服务器部署验收。本轮没有制作安装包。

早期检查遇到 K 盘临时目录清理超时，换用独立临时目录重跑通过；Windows 自动删除证据曾报权限错误，后续使用工具自带的证据保留模式，应用及资源释放检查照常执行。官方 CLI 初轮有两例超过 Windows 路径长度，换用独立短临时根后 19 项通过。失败日志和原工具版本均保留，不修改原始证据或放宽断言。

本地忽略目录 `.qa/final-extraction-20261124-v1/` 保留逐项日志、工具摘要、冻结源码清单及结果。最终成功记录使用 `granular-*`、`windows-*-granular` 标签；旧轮次保留原归属。

## 工作树与范围

其余 13 个工作树的 HEAD、状态、索引、未完成合并标记及 12217 个文件摘要与开始前一致；总数仍为 14。第 12、14 号现场及第 9 号 IPC 工作树保留原样。原已合并委派分支记录保留；本地 main 和 origin/main 保持 `eab6b7d`。

本轮不推送、合入 main、打包或清理其他工作树。既有数据路径、资料格式、IPC／Preload 契约、UI 和权限策略保持不变。

## 代码与测试文件清单

- `src/main/agentIpc.ts`
- `src/main/api/ApiRuntimeConfiguration.ts`
- `src/main/automation/AutomationExecutionBridge.ts`
- `src/main/automation/AutomationTargetPolicy.ts`
- `src/main/diary/DiaryGenerators.ts`
- `src/main/memory/fallback/MemoryConsolidation.ts`
- `src/main/notebook/PartnerProjectNotebookService.ts`
- `src/main/partner/PartnerProfileService.ts`
- `src/main/project/ProjectTaskOrchestrator.ts`
- `src/main/project/ProjectTaskRuntime.ts`
- `src/main/project/ProjectWorkflowGenerationRuntime.ts`
- `src/main/runtime/DelegationConversationRuntime.ts`
- `src/main/runtime/DelegationExecutor.ts`
- `src/main/runtime/DelegationToolHandler.ts`
- `src/main/runtime/ExistingThreadService.ts`
- `src/main/runtime/LegacyRunPath.ts`
- `src/main/runtime/LocalRuntimeResolver.ts`
- `src/main/runtime/MessageRuntime.ts`
- `src/main/runtime/RuntimeEventBridge.ts`
- `src/main/runtime/RuntimeRunHooks.ts`
- `src/main/runtime/RuntimeToolBindings.ts`
- `src/main/runtime/SessionMaintenanceRuntime.ts`
- `src/main/security/localPath.ts`
- `src/main/studio/StudioTurnRuntime.ts`
- `tests/unit/localRuntimeResolver.test.ts`
- `tests/unit/partnerProjectNotebookService.test.ts`
- `tests/unit/runInteractionIpc.test.ts`
