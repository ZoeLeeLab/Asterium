# 最终收尾：文件颗粒度审查

本轮复用第 13 号工作树，在 `codex/agent-ipc-final-service-extraction` 分支实施。四组迁移提交保留，按补充验收约束追加归并，不改写已完成记录。审查以业务边界、状态所有者和调用关系为依据，不以缩短主文件或函数数量为目标。

## 归回现有模块的六个文件

| 原新增文件 | 最终归属 | 归并理由 |
| --- | --- | --- |
| `src/main/diary/DiaryGeneration.ts` | `src/main/diary/DiaryGenerators.ts` | 日记生成策略与原有 API、Codex、Claude、桥接生成器共同维护。 |
| `src/main/memory/MemoryModelConnections.ts` | `src/main/memory/fallback/MemoryConsolidation.ts` | 导入和整理的模型连接复用原有适配器工厂，不另设连接转发层。 |
| `src/main/partner/profileSeedValidation.ts` | `src/main/partner/PartnerProfileService.ts` | 资料输入校验与资料同步、保存业务保持同一领域归属。 |
| `src/main/ipc/markdownExport.ts` | `src/main/security/localPath.ts` | 导出名称处理作为共享本地路径辅助能力维护，不单设五行文件。 |
| `src/main/runtime/DelegationRuntimeBridge.ts` | `src/main/runtime/DelegationConversationRuntime.ts` | 原对话回传装配与既有目的地解析、结果提示和只读工具约束共同维护。 |
| `src/main/project/ProjectRuntimeBindings.ts` | `ProjectTaskRuntime.ts`、`ProjectWorkflowGenerationRuntime.ts`、`ProjectTaskOrchestrator.ts`（均在 `src/main/project/`） | 两类启动配置分别归对应运行服务；项目状态协调归既有编排器，不保留集中转接文件。 |

以上归并保留函数实现、校验与调用顺序。原文件不保留再导出空壳。

## 保留的十三个新增源码模块

| 文件 | 独立存在的理由 |
| --- | --- |
| `src/main/api/ApiRuntimeConfiguration.ts` | 多处运行和 IPC 共用的请求／模型设置解析、凭据及请求头解析、附件能力校验，保持单一规则入口。 |
| `src/main/automation/AutomationExecutionBridge.ts` | 持有自动化项目写租约，完成审批、启动命令、结果保存、外部身份复查及执行后的租约释放。 |
| `src/main/automation/AutomationTargetPolicy.ts` | 集中处理目标枚举、工作区指纹、线程和群聊资格复查、命令关联，供管理界面和执行期共同使用。 |
| `src/main/runtime/DelegationExecutor.ts` | 执行一次性本地／API 委派及原线程桥接任务，负责材料校验、发送前权限复查和不确定回执查询。 |
| `src/main/runtime/DelegationToolHandler.ts` | 负责模型工具请求的目标筛选、材料来源与快照、read/write 提示和入队准备；执行端仍独立复查。 |
| `src/main/runtime/LegacyRunPath.ts` | 保有旧路径完整的写租约、事件消费、绑定、失败和释放生命周期，继续由原环境开关选择。 |
| `src/main/runtime/LocalRuntimeResolver.ts` | 唯一持有安装缓存，协调显式刷新、运行时选择、导入目录、线程身份及工作区授权解析。 |
| `src/main/runtime/MessageRuntime.ts` | 拥有 API／本地消息启动流程：准备消息、幂等指纹、工作区解析，以及拿到租约后的本轮配置复查。 |
| `src/main/runtime/RuntimeEventBridge.ts` | 处理运行事件的窗口路由、模型观察、工具输出持久化和文件交付变换，维护输出边界。 |
| `src/main/runtime/RuntimeRunHooks.ts` | 按运行阶段协调委派、自动化、项目和群聊的绑定、完成、失败与释放，供既有协调器调用。 |
| `src/main/runtime/RuntimeToolBindings.ts` | 按实际命令绑定记忆、笔记、委派、自动化及群聊工具；延迟读取本轮服务引用和 Main 管理的消息来源。 |
| `src/main/runtime/SessionMaintenanceRuntime.ts` | 协调 API／本地会话压缩与资料重载，含原线程检查、临时适配器释放、资料提交及回滚。 |
| `src/main/studio/StudioTurnRuntime.ts` | 负责群聊原生绑定预留、原线程变更检测、失效重建与附件轮次准备；存储与群聊调度仍归既有服务。 |

部分模块只导出一个工厂，但内部承担完整业务流程或生命周期。主文件保留构造、注入、事件连接、注册及统一清理，不为薄回调单设文件。仅用于依赖注入类型的引用显式标为 `import type`；转换前后生成 JavaScript 的有效令牌一致。

## 其余新增文件

| 文件 | 理由 |
| --- | --- |
| `tests/unit/localRuntimeResolver.test.ts` | 独立验证共享缓存／刷新、运行时回退、保护目录、授权、导入线程身份和删除状态。 |
| `docs/agent-ipc-final-service-extraction.md` | 实施边界、数据流、四组职责和必须保持的行为。 |
| `docs/agent-ipc-final-service-granularity.md` | 记录本次颗粒度审查、归并结果和逐文件理由。 |

归并后重新执行受影响领域定向测试、默认全量、类型、Lint、隐私检查，再提交代码；累计 Windows 验收绑定归并后的代码提交。
