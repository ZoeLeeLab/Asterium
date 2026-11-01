# 能力总索引

本目录是静态能力词典，不自动注入模型，不授予目录、工具或成员权限。代码范围与权限边界以各条目为准。

16 条能力的核验来源以各条目的 lastVerifiedCommit 为准：首次代码基线建立前为 null，基线存在后须核验并绑定已存在的代码提交。不能将旧候选、旧提交或旧测试电脑的结果归属于本仓库的新候选。参见 [发布状态](../release-status.md) 和 [条目规范](schema.md)。

- [Anthropic Messages](entries/api-anthropic-messages.md)
- [通用 Chat Completions](entries/api-chat-completions.md)
- [共享 API 连接与模型配置](entries/api-connections.md)
- [API 伙伴 MCP、Skills 与网络工具](entries/api-extensions.md)
- [Gemini 原生 Generate Content](entries/api-gemini.md)
- [OpenAI Responses](entries/api-responses.md)
- [API 会话与手动压缩](entries/api-sessions.md)
- [通用自动化](entries/automations.md)
- [桌面通用设置](entries/desktop-settings.md)
- [伙伴记忆](entries/memory.md)
- [伙伴接入](entries/partners.md)
- [运行状态、项目与协作工具](entries/runtime-tools.md)
- [外部伙伴群聊 MCP](entries/studio-mcp.md)
- [星丛 Wake 通知与参考 SDK](entries/studio-wake.md)
- [工作室与群聊](entries/studio.md)
- [文件、命令与交付](entries/workspace-tools.md)

## 0.1.0-beta.1 本轮维护

伙伴接入、运行工具、记忆、桌面设置及文件命令五条绑定本轮已存在代码提交；其余十一条保留原真实来源。API 协议、业务存储、工作室外部协议与 Wake 边界未变化，未另作实现或验收升级。详情见各条；新候选仍需独立自动检查和人工验收。

构建缓存校验修复 `14055d8342f8ec4acaf195101055145991f06f2a` 不改变伙伴工具、协议、权限或用户能力，只对构建用官方 Electron ZIP 校验锁定 npm 元数据中的哈希。本项无需重新绑定能力条目；原代码来源引用继续保留，最终候选的构建与检查证据另记。

前次原生命令诊断按错误的 Full 隔离假设停止；维护者已明确原生账户权限并授权继续。旧证据保留，当前说明见 [语义澄清记录](../claude-cli-release-blocker.md)。伙伴接入、运行工具及 Wake 验收来源绑定本轮已存在代码提交，其余条目保持原真实引用。Wake 业务能力未变，不宣称外部宿主原线程真实接通。
