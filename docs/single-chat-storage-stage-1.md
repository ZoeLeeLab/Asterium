# 单聊存储迁移第一阶段

本阶段基于 Beta.5 源码基线 `7cc7384`。迁移提交边界和本地 Codex 原线程读取分别验证。

## 迁移模块

`src/main/conversation/SingleChatHistoryStore.ts` 接收已解析的旧会话和删除记录。它先在 profile 下创建独立的 `single-chat-history.stage-*` 目录，按会话写入 `conversations/<会话 ID 的 SHA-256>/events.jsonl`。逐个校验实际写入的字节和事件数量，再把整个暂存目录改名为 `single-chat-history.v2`。读取已激活目录时必须成功解析 `manifest.json`，已激活目录缺少清单时报告错误。

发现已激活的清单后，迁移入口直接返回该代，跳过旧源读取。后续追加要求当前代和会话版本匹配。回放保留最后一个换行之前的完整事件。下一次追加前会备份残尾，并从最后一个完整边界继续。删除记录在初次导入时阻止复活被删除的会话。测试资料全部由合成数据创建。

本阶段在隔离 profile 验证迁移模块。正式应用的启动切换、Beta.1–Beta.5 旧源合并、API 与本地伙伴的发送前及结束点写入、失败提示、删除和查询投影切换在后续阶段接入。届时再逐项核对附件引用、API 会话、自动化和旧版覆盖安装。SQLite 查询索引、长历史分页和中文搜索也属于后续阶段。第一阶段仍可从旧版路径启动已有 profile。

## Codex 原线程

`src/main/agentIpc.ts` 的只读 IPC 先核对会话与原线程的绑定、删除状态、运行环境和工作区授权。`src/main/adapters/CodexCliAdapter.ts` 优先用 `thread/turns/list` 分页读历史。仅在运行时明确不支持该接口时兼容 `thread/read`。续聊仍经同一个线程 ID 调用 `thread/resume`，返回不同的 ID 时停止。

`src/renderer/app/nativeCodexHistory.ts` 将最新原线程页与星丛已有消息合并显示。匹配到旧回复时保留其本地消息 ID、用户消息和可复用的工具时间线，原线程正文可以补回旧快照缺失的部分。单聊提供更早原线程页的入口。读取失败时保留当前已有记录。恢复的正文只作为当前视图的读取结果。

## 验证入口

- `tests/unit/singleChatHistoryStore.test.ts` 覆盖旧源重复导入、过期代与版本、迁移重试、清单缺失、多个长会话和强退后的残尾修复。
- `tests/unit/codexCliAdapter.test.ts` 核对读取绑定的原线程及分页参数。`tests/unit/nativeCodexHistory.test.ts` 核对缺失正文恢复和原消息去重。
- `tests/long-chat-browser.mjs` 用合成历史覆盖原线程补全、300 轮单聊的导航和输入。中文组字经浏览器合成事件验证，Windows 实际输入法需要在后续桌面验收中单独核对。

本机 Codex App Server `0.167.0-alpha.3.2` 使用独立 profile 和本机合成模型服务。回复完成后强制结束 App Server，再启动同一运行时，以原 ID 分页读回完整回复。测试未使用日常 profile 或真实 API 连接。

300 轮浏览器样本覆盖空闲、回复中、空闲时中文组字、回复中中文组字。四段均未记录 50 ms 以上的长任务。回复中中文组字记录 16 次组合事件、27 段流式更新，候选确认键没有误发送。该样本测量源码界面和合成原线程读取，不包含后续阶段的实时落盘。
