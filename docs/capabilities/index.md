# 全局能力说明书

当前源码完成同机日常、开发、人工验收和自动测试的资料隔离及自定义默认项目位置；本轮尚未构建、安装或发布新产品包，不将新源码行为追溯到已公开 beta.1。

竖图头像修复和记忆 API 的核验范围见[阶段记录](../avatar-memory-fallback-2026-11-02.md)。伙伴委派的实现和验证范围见[委派记录](../partner-delegation-implementation.md)。

2026-11-02 S5：桌面设置、文件与交付、工作室、群聊 MCP、Wake 和自动化六条绑定已存在的 S4 代码提交 `89a6c2dfd803b470690f1a2993d8ba729e981dca`；其余十条保留原真实来源。完整词典审计与未验收边界见 [S5 审计](../development-data-isolation-s5.md)。

Beta.5 工作区的单聊存储切换、原线程和隔离验收边界见[第二阶段记录](../single-chat-storage-stage-2.md)。SQLite 索引、历史分页和搜索见[第三阶段记录](../single-chat-storage-stage-3.md)。

本目录是静态结构化词典，不自动注入模型，不授予目录、工具或成员权限。当前限制以条目正文为准；历史阶段记录不代表当前未实现或已完成真实联调。

- [Anthropic Messages](entries/api-anthropic-messages.md)
- [通用 Chat Completions](entries/api-chat-completions.md)
- [共享 API 连接与模型配置](entries/api-connections.md)
- [API 伙伴 MCP、Skills 与网络工具](entries/api-extensions.md)
- [Gemini 原生 Generate Content](entries/api-gemini.md)
- [OpenAI Responses](entries/api-responses.md)
- [API 会话与手动压缩](entries/api-sessions.md)
- [通用自动化](entries/automations.md)
- [桌面通用设置](entries/desktop-settings.md)（含截图快捷键、单聊搜索、回合导航和工具输出）
- [伙伴记忆](entries/memory.md)（含旧对话文本导入）
- [伙伴接入](entries/partners.md)（含本机 Codex 原线程历史和搜索、单聊模型切换和 CyberBoss 单聊附件）
- [运行状态、项目与协作工具](entries/runtime-tools.md)（含接回伙伴 Markdown 复核及宿主接线契约）
- [外部伙伴群聊 MCP](entries/studio-mcp.md)（含接入凭据复制）
- [星丛 Wake 通知与参考 SDK](entries/studio-wake.md)
- [工作室与群聊](entries/studio.md)（含项目群上传归档与项目文件交付）
- [文件、命令与交付](entries/workspace-tools.md)（含聊天附件拖放、粘贴、单聊本地文件引用及交付文件右键操作）

维护见 [条目规范](schema.md)、[模板](template.md) 和根目录 [AGENTS.md](../../AGENTS.md)。本轮代码／脚本提交和各阶段验收归属见 [五阶段记录](../development-data-isolation-progress.md)。
