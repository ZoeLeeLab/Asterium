# 同机资料隔离 S5：综合核验与能力基线

日期：2026-11-02。本阶段只维护文档与能力元数据，不改产品代码、测试代码或已有候选，不写自身或未来提交号。S1–S4 的提交与历史失败均保留，未 push、安装或发布。

## 已完成与源码归属

| 阶段 | 已存在提交 | 内容 |
| --- | --- | --- |
| S1 | `ea6634abec534eedd07d65dec8853d4a4b30a315` | 四种启动环境、真实路径和目录归属、最小并行 |
| S2 | `6e0e5a81057f940e603a96f3fdfbb97a0f41d14e` | 默认项目位置、旧项目不搬迁、创建前最终位置确认 |
| S3 | `d55852db27c079bc0c67258dd982b729cb78d6ed` | 独立验收启动器及系统 Utility 模块选择修复 |
| S4 | `73c183ad70ad5c5a498e3d9cfd6780ae866414ee` | 自动测试 run／worker／case、入口迁移与受限清理 |

复核时补充了“从星丛内启动测试所继承的 TEMP”边界：测试分配器使用独立 Windows Local/Temp 或明确保留的系统测试根，拒绝落入任何已标记的应用资料树。该补充为已存在提交 `89a6c2dfd803b470690f1a2993d8ba729e981dca`，是本次六条能力的最终代码基线；保留 S4 原提交，不改写其历史。

## 验证范围

- S1：70 项相关检查及真实 Electron 窄范围四环境并行、重复实例、junction 拒绝和重启保存通过。S2：23 项相关检查通过。S3：3 项启动器检查通过，SHA-256 对照 Node crypto，系统 PowerShell 5.1 正确加载其自身现有 Utility 3.1。
- S4：213 个文件、1670 项通过、0 失败、2 项既有 TODO；托管独立入口另有 renderer-only 7 项、Wake mock 6 项、自动化 mock 4 项和真实 Electron 窄并行通过。临时 SDK 在本轮 worker 中从源码构建，不复用共享 out。
- 新的继承 TEMP 边界采用合成日常目录验证，不读取实际日常资料；两项新增检查与其余生命周期检查共 10 项通过。补充后的最终完整回归为 213 文件、1672 项通过、0 失败、2 项既有 TODO；日志在 Git 忽略的 `.qa/s4-temp-boundary-c1c930f0a47e40c79d44480802e8f5da/vitest.log`。
- 没有运行未获指定连接的真实 API／CLI 会员服务、CyberBoss 外部宿主或新产品包。模拟和源代码检查不等于安装包或真实伙伴验收。

## 全词典审计

逐条检查全部 16 条能力的字段、ID、路径、真实提交和源码归属。桌面设置、文件与交付、工作室、群聊 MCP、Wake 和自动化六条记录本轮启动／项目位置／后台恢复变化；名称、协议、适用对象、权限边界和状态定义保留，未增加伙伴权限。其余十条的协议、工具、存储格式和权限没有本轮产品变化，保持原真实来源；共同资料根隔离由桌面条目说明。

| 条目 | 本轮处理 | lastVerifiedCommit |
| --- | --- | --- |
| [Anthropic Messages](capabilities/entries/api-anthropic-messages.md) | 保留既有来源 | `39122d3a15ba44f14568d6826b7dc5b590266cea` |
| [通用 Chat Completions](capabilities/entries/api-chat-completions.md) | 保留既有来源 | `39122d3a15ba44f14568d6826b7dc5b590266cea` |
| [共享 API 连接与模型配置](capabilities/entries/api-connections.md) | 保留既有来源 | `a2c23abe4e2462e5a32660c56c875026f2164e45` |
| [API 伙伴 MCP、Skills 与网络工具](capabilities/entries/api-extensions.md) | 保留既有来源 | `39122d3a15ba44f14568d6826b7dc5b590266cea` |
| [Gemini 原生 Generate Content](capabilities/entries/api-gemini.md) | 保留既有来源 | `39122d3a15ba44f14568d6826b7dc5b590266cea` |
| [OpenAI Responses](capabilities/entries/api-responses.md) | 保留既有来源 | `39122d3a15ba44f14568d6826b7dc5b590266cea` |
| [API 会话与手动压缩](capabilities/entries/api-sessions.md) | 保留既有来源 | `39122d3a15ba44f14568d6826b7dc5b590266cea` |
| [通用自动化](capabilities/entries/automations.md) | 本轮核验绑定 | `89a6c2dfd803b470690f1a2993d8ba729e981dca` |
| [桌面通用设置](capabilities/entries/desktop-settings.md) | 本轮核验绑定 | `89a6c2dfd803b470690f1a2993d8ba729e981dca` |
| [伙伴记忆](capabilities/entries/memory.md) | 保留既有来源 | `10437a8d41a665073d7c091ce2dc31ad805ba0ad` |
| [伙伴接入](capabilities/entries/partners.md) | 保留既有来源 | `2b084045c0f923bba54127d0cb3366a730df55f5` |
| [运行状态、项目与协作工具](capabilities/entries/runtime-tools.md) | 保留既有来源 | `a4a5ace1446b0a2601099cae337c21fbb56a8fb8` |
| [外部伙伴群聊 MCP](capabilities/entries/studio-mcp.md) | 本轮核验绑定 | `89a6c2dfd803b470690f1a2993d8ba729e981dca` |
| [星丛 Wake 通知与参考 SDK](capabilities/entries/studio-wake.md) | 本轮核验绑定 | `89a6c2dfd803b470690f1a2993d8ba729e981dca` |
| [工作室与群聊](capabilities/entries/studio.md) | 本轮核验绑定 | `89a6c2dfd803b470690f1a2993d8ba729e981dca` |
| [文件、命令与交付](capabilities/entries/workspace-tools.md) | 本轮核验绑定 | `89a6c2dfd803b470690f1a2993d8ba729e981dca` |

原始 Beta 和更早候选的 SHA、安装证据、返回原件及验收结论不重新归属于本轮源码；字典正文中保留的历史段落已与当前核验分开。

## S5 验收结果

完整 `check:capabilities` 16 条通过；能力注册表 3 项测试通过；104 个本地文档链接通过。逐字段核对 16 条的名称、ID、适用对象、协议、权限边界和状态均未改变；六条引用最终已存在代码基线，其余十条引用保持原值。S5 差异清单仅包含 README 和 docs 下的 Markdown，没有产品或测试代码变更，diff check 通过。

typecheck、lint 和 213 文件／1672 项完整回归由 S4 补充代码基线的已通过检查支持，本阶段不重复宣称执行新的产品包或人工安装验收。S5 提交自身的 SHA 在创建后由 Git 提供，本记录不写自引用。

## 未完成或未验收

- 两项既有 TODO 保留：重生成约定，以及群聊／私聊记忆设置隔离；不将 TODO 自动记作已确认产品缺陷。
- 没有生成包含本轮源码的新产品包；新包完整界面、安装／卸载／跨版本升级与资料保留尚未实际验收，原 Beta 未覆盖。
- 官方 CLI 登录、原生线程和记忆仍由宿主管理，本轮应用数据隔离不宣称隔离它们或约束原生命令的既有账户权限。
- 35 个独立 Node 入口已迁移，带真实连接、官方 CLI 或固定候选前提的检查本轮未实际运行；不将代码迁移写成这些场景全部通过。
- watch 以单次调用为运行归属，持续使用新 worker／case，保留目录待退出后显式清理；不主动清理旧格式、旧验收或异常遗留资料。

普通运行成功默认清理，失败保留；清理器只接受显式指定、归属和真实路径有效、已停止的单个运行，拒绝目录链接和活跃进程。详细方式见 [自动测试隔离](automatic-test-isolation.md) 和 [五阶段记录](development-data-isolation-progress.md)。
