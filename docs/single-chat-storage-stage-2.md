# 单聊存储迁移第二阶段

第一阶段代码提交为 `323cfab`，能力核验提交为 `6a27365`。本阶段在 Beta.5 工作区接入实际桌面写入和恢复。

## 启动迁移与写入边界

- 已核对 Beta.1–Beta.5 对应源码使用同一个旧状态键 `asterium.prototype.v7`。新版按现有字段规范化旧状态和缺省值。
- `src/renderer/app/useSingleChatHistory.ts` 启动时先调用 `openHistory`。已有激活代时只读新资料。尚未迁移时，`persistence.ts` 读取并规范化旧 `asterium.prototype.v7`。遇到不可解析的旧源会提示重试读取。
- `src/main/agentIpc.ts` 的迁移入口在主进程合并 `single-chat-messages.v1.json` 中的补充消息，按会话、消息 ID 去重，保留附件与本地消息详情，应用删除记录。已存在激活代时不调用旧源读取逻辑。
- `src/main/conversation/SingleChatHistoryStore.ts` 把会话日志和不含对话正文的 `profile.json` 一起暂存、校验并激活。正式桌面使用 `single-chat-history.v2`。新日志写入检查代、会话归属和删除标记。旧快照及旧投影留作回退资料。
- 用户消息的写入确认在调用伙伴之前。工具结果返回时保存已有正文与结果，纯文字回复在结束时保存。流式文本增量、工具进度和思考增量只更新界面。结束点使用串行写入，写入错误保留队列并提示重试。
- 单聊强退后重放完整记录。恢复界面标记中断，尚未确认的发送留作待核对记录，打开会话不会重发消息或执行工具。尾部不完整时，保留可读历史，下一次追加前先留存残尾。
- `SingleChatMessageStore.ts` 的查询转为从日志构造投影，记忆、日记、自动化和交接继续走原来的查询接口。主进程产生的自动化结果进入同一会话日志。

## Codex 与范围

本机 Codex 的显示恢复和继续对话仍按绑定的原线程。运行端首次绑定时，主进程先把线程 ID 写入已提交的单聊，再通知界面。同步绑定时核对新版已提交的会话和线程 ID。第二阶段继续保留星丛本地的显示副本供原有查询和原线程暂不可读时使用。后续索引阶段再完成 Codex 原生正文到查询投影的接入和副本收敛。

当前启动会一次加载已保存的会话，工具断点追加的是发生变化的消息快照。SQLite 索引、全部长历史的分页与搜索、大工具输出分离、极限大档案迁移、备份与降级交互属于后续阶段。旧版覆盖回退会读旧资料，无法看到新版新增会话。源码 Electron 验证使用隔离 profile，不代表 NSIS 覆盖安装或系统中文输入法已验收。直接用旧 localStorage 注入夹具的实机验收脚本须在候选放行前接入新版测试夹具路径。

## 验证入口

- `tests/single-chat-history-electron.mjs` 构建源码并启动隔离的 Windows Electron，验证旧快照、旧投影、真实 IPC、强制退出及旧快照重放。
- `tests/renderer/SingleChatHistoryCutover.test.tsx` 验证发送前写入、无工具回复、工具断点恢复和模拟磁盘写失败。
- `tests/unit/singleChatHistoryStore.test.ts` 用独立子进程验证长会话和残缺尾部。
- `tests/long-chat-browser.mjs` 验证 300 轮、流式回复、真实磁盘日志、工具断点和浏览器中文组字。测量包含中文候选确认期间的流式输出。
