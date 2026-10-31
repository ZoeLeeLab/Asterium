# API 伙伴的 MCP 与 Skills

设置中的“MCP 管理”和“Skills 管理”只管理 API 伙伴。本地 CLI 与接回伙伴沿用自己已有的配置。单聊的“插件”也能进入管理页；工作室的 API 发言使用同一个 Main 运行时及绑定配置。

## 配置 MCP

1. 添加 MCP，选择本地 stdio 程序或 HTTP 服务。参数填写 JSON 字符串数组，例如 `["C:\\tools\\server.mjs"]`，不会按 shell 命令拆分。stdio 未设 cwd 时使用用户主目录。
2. 凭据放在专用输入区：stdio 为环境变量，HTTP 为请求头。值加密保存，不回显。编辑时可明确保留、替换全部或清除全部。
3. 为需要使用它的 API 伙伴开启绑定。测试连接会启动程序或访问地址、发现工具；不会执行工具或建立信任。管理测试连接与伙伴会话独立。
4. 未信任 MCP 的连接初始化和工具副作用遵循当前审批；所有 MCP 工具均按外部副作用处理，不依赖服务声称的 readOnlyHint。模型仅拿到工具别名，不提供信任管理工具。

## 让 API 伙伴安装 MCP

可以在普通对话中明确告诉 API 伙伴要安装的 MCP，并提供官方安装说明或启动配置。伙伴先用 `asterium_mcp_list` 查看自己的 MCP，必要时用现有 `run_command` 安装服务依赖，再用 `asterium_mcp_install` 登记 stdio/HTTP 配置并绑定自己。官方 npx/uvx 启动方式也可在首次连接时解析包；本机需具备对应运行环境。

manual / automatic 模式会依次审批安装登记、未信任服务的启动和实际工具调用；full 沿用现有完整权限规则。新安装服务始终未信任，不会获得其他伙伴的信任或凭据。安装入口不能修改其他伙伴、覆盖已有配置或开启持续信任；同名同配置且已启用的自有服务会复用。同名配置冲突或已停用服务需到管理页处理。审批期间设置或工作区变化后，旧请求失效，不自动重试。

stdio 使用当前已授权主工作区作为默认 cwd，未配置主工作区时不能安装本地服务；HTTP 不要求本地工作区。只读和 Plan 仅可查看自己的配置，不能安装。凭据需由用户在 MCP 管理的专用输入区填写，不能通过模型安装参数设置；需要交互登录或服务专有环境时，仍按服务自己的说明完成。登记成功后，下个模型轮次连接并发现工具；只有后续连接和调用成功才代表可用。安装结果会同步显示在 MCP 管理。

本地 Codex、Claude Code 和接回伙伴继续使用各自的 MCP 配置方式，这个入口只给星丛 API 伙伴。

## 配置 Skill

添加含 SKILL.md 的文件夹绝对路径并绑定 API 伙伴。最低格式：

```markdown
---
name: my-skill
description: 说明何时适用这个技能。
---
先读取 references/example.md，需要执行时使用本技能脚本工具运行 scripts/main.mjs。
```

模型先看到名称/简介，用对应 skill_read 工具读取说明及准确清单中的参考文本。Skill 说明不会增加工作区或放宽系统规则。只读/Plan 可读取说明和文本，不能执行脚本。二进制、URI 和外部引用不会自动打开。

脚本位于 scripts/，支持 .js/.mjs/.cjs、.py、.ps1。模型只选择包内脚本和字符串 argv；Main 选择解释器和当前授权主工作区。没有主工作区时不提供脚本执行。Node 使用应用自带运行时；Python 需要 PATH 上已有实际解释器，Windows Store 别名不算；Native PowerShell 遵守本机执行策略；沙箱 Skill 的固定解释器使用仅限子进程的执行策略参数与 UTF-8 启动环境，不修改系统或用户长期策略。不会自动安装依赖。

每次执行使用审批对应的临时包副本，脚本以 `import.meta.url`/`__dirname` 或 `ASTERIUM_SKILL_DIRECTORY` 定位随包资源，以 cwd 定位输出工作区。不要依赖原包绝对路径、node_modules、隐藏文件或在包目录写入结果。依赖需要预先安装或预先打包；运行时不自动下载。

包上限：512 个遍历项、256 个文件、12 层、单文件 1 MiB、合计 8 MiB；SKILL.md 与返回文本各 256 KiB。拒绝符号链接/junction 和受保护档案目录，忽略隐藏项、.git、node_modules、__pycache__。脚本最长 30 秒，stdout/stderr 合计 64 KiB；失败、超限、取消会返回失败并清理临时副本。脚本输出不自动成为交付，需正常调用 deliver_file。

可用示例：[工作区报告 Skill](../examples/api-skills/workspace-report/SKILL.md)。把该文件的**父文件夹**注册为 Skill，在一个测试工作区请求生成报告即可。示例仅列出顶层条目、独占创建新文件，不覆盖既有报告。

## 持续信任

设置“申请持续信任”只会进入待首次确认。下一次真实 MCP 工具/Skill 脚本审批中，必须明确选“允许并持续信任此 MCP / Skill”才会激活；“允许一次”始终只允许本次。

| 模式 | 未信任扩展 | 已信任 MCP / Skill 脚本 |
| --- | --- | --- |
| manual / automatic，普通模式 | 沿用现有逐次审批 | 免逐次确认 |
| full，普通模式 | 沿用完整权限，无强加审批、不静默激活 pending | 无逐次审批 |
| read_only / Plan | MCP 和技能脚本不可执行；Skill 说明可读 | 同样受限 |
| workflow_planning | 不挂载 MCP / Skill | 同样受限 |

信任跨已绑定 API 伙伴、对话和重启共享。信任 MCP 不信任 Skill，信任 Skill 只涵盖其包内脚本，不授权普通 run_command 或 MCP。绑定与启用始终必需。

在设置中可查看、取消 pending 或撤销信任。撤销后未发起的调用恢复审批，等待中的旧审批不能恢复信任；已发起的副作用不能回滚。配置/凭据/工具目录或技能包任何纳入库存的文件变化后，需要重新审批；纯显示名称变化不影响信任。技能变化在下次发现/执行复核时检测。

默认使用 Native。开启 Windows 沙箱且非 Full 时，command、Skill 与 MCP stdio 使用 AppContainer/Job 后端；审批和参数预检本身不等于隔离。Full 使用 Native，普通审批或持续信任不授予沙箱外执行能力；沙箱失败不自动回退 Native 或重放。HTTP MCP 远端服务内部行为不由本地沙箱隔离。沙箱属于实验能力，具体边界见 [命令审批](native-command-approval.md)。

## 开发与验收

依次运行 `npm run typecheck`、`npm run lint`、`npm test -- --reporter=dot --maxWorkers=2`，新鲜打包后运行 `npm run test:extensions`（无模型请求）。`npm run package` 保留标准下载校验；网络不可用时可复用已校验 Electron 缓存，并从 node_modules/electron/checksums.json 向内存 Forge 配置提供 checksums，不能跳过校验。

真实 API 验收需要维护者明确授权，并同时设置 ASTERIUM_API_LIVE_SMOKE=1 与 ASTERIUM_API_SMOKE_SOURCE_USER_DATA（绝对路径，必须是指定的隔离测试资料）。脚本不再默认读取个人应用目录。来源内必须有专门配置的测试连接；不得直接指向日常资料。只复制指定测试条目到临时目录，并核对来源未被修改；本轮发布清理不运行真实测试。

验收串行运行，包含加密存储/重载、stdio/HTTP 生命周期、启动回归、真实 MCP 自助安装/设置 UI、Skill 脚本、真实应用重启、包更新和撤销后重批；摘要在忽略目录 .qa/s8-acceptance。更换服务或技能自己的依赖、账号权限和外部系统行为，应按该包自己的说明单独验证。
