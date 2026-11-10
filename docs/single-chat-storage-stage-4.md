# 单聊存储迁移第四阶段

第三阶段代码提交为 `36831b1`，能力核验提交为 `c7e8446`。

## Codex 原线程搜索

- `src/main/agentIpc.ts` 中的 `resolveBoundCodexHistory` 校验当前单聊绑定和工作区授权，通过当前所选本机 Codex 运行时读取原线程。返回分页或搜索结果前再次校验绑定及删除状态。
- `src/main/adapters/CodexCliAdapter.ts` 的 `searchCodexThreadHistory` 每次搜索使用一个 App Server 连接。通过 `thread/turns/list` 分页查找，不支持分页的运行时在同一次查询内复用一次 `thread/read`。每批返回最多 100 条匹配。新的查询取消上一查询，单次查询最多等待 60 秒。原线程正文、工具结果、搜索索引都无需另建一份持久副本。搜索覆盖可见用户和助手正文，沿用现有正文搜索的标准化规则。工具内容和注入的附件快照信息不计入匹配。
- `src/renderer/components/chat/ConversationSearch.tsx` 可切换 Codex 原线程和星丛记录。原线程搜索失败时可切换本地记录。侧栏仍搜索星丛 SQLite 投影。
- `src/renderer/app/nativeCodexHistory.ts` 按搜索命中的原回合定位历史页。这个窗口只用于浏览，发送仍通过存储会话和原线程 ID。源页位置变化时按原回合 ID 查找。此前保存的星丛显示记录继续供本地搜索、记忆、日记和交接使用。

## 工具输出

- `src/main/agentIpc.ts` 的 `transformRuntimeEvent` 在单聊工具完成时分离超过 16 KiB 的详情。这里的大小只决定存放位置。发送前、工具完成和回复结束的检查点规则沿用第二阶段。
- `src/main/conversation/SingleChatToolOutputs.ts` 将正文写到当前资料环境的 `single-chat-history.v2/conversations/<会话 ID SHA-256>/outputs/<内容 SHA-256>.txt`。先写并刷盘临时文件，再更名，然后才把引用交给写入检查点。相同会话中相同字节只保存一份。星丛已有的授权和工具标签可继续使用详情中的精简展示字段。
- `src/main/conversation/SingleChatHistoryStore.ts` 对首次迁移和新增的检查点应用同样规则。即时分离失败时，检查点使用收到的详情重试。失败沿用现有的保存错误与重试。已激活资料的旧日志按原样保留。日志可在新检查点使用外置输出，旧行不会就地重写。应用强退发生在文件保存和检查点之间时，可能留下无引用的输出，随该会话清理。
- `src/renderer/components/chat/TurnTimeline.tsx` 通过单聊 IPC 按需读取，单段最多 64 KiB 并保持 UTF-8 字符边界。找不到或无法读取时允许重试。路径由主进程按会话和内容 ID 计算。删除单聊先登记删除，再清理专属输出文件。
- `src/main/api/ApiAgentRuntime.ts` 在单聊完成大型工具调用时，把工具执行层已生成的结果交给星丛历史，供主进程分离保存。模型的工具消息保留原有结构和内容。现有 API 运行会话默认保留至多 30 轮、16 MiB 的近期模型上下文，并有现有压缩选项。聊天日志保存的历史和模型此刻收到的上下文是两个范围。
- 保留的是已到达星丛的工具完成详情。Codex 的历史工具项当前显示原线程提供的工具摘要，底层运行时自己的原始输出和已有截断仍由该运行时负责。

## 验证

- `tests/unit/codexCliAdapter.test.ts` 覆盖原线程分页、跨页命中、后续匹配、旧运行时兼容和定位。单元测试使用合成 App Server。
- 本机 Codex App Server `0.167.0-alpha.3.2` 在独立 Codex 资料目录使用本机合成模型服务生成 32 轮。重启后首次只读 30 轮，再用原线程搜索并定位到首轮回复。搜索和定位期间合成模型服务收到零次请求。
- `tests/unit/singleChatHistoryStore.test.ts` 覆盖首次迁移、输出去重、UTF-8 边界、重启读回、会话隔离、删除和写入失败重试。
- `tests/renderer/SingleChatHistoryCutover.test.tsx` 覆盖原线程搜索跳转、失败后切换和工具输出展开。`tests/unit/apiAgentRuntime.test.ts` 验证大工具结果进入历史事件，同时保留原有模型会话数据。
- 完整回归 227 个测试文件，1,778 项通过，2 项已有 TODO。类型、能力、源码隐私检查通过。改动范围的 ESLint 无错误，`PrototypeProvider.tsx` 留有 17 项已有依赖警告。
- `tests/single-chat-history-electron.mjs` 在独立 Windows Electron 资料目录验证已保存消息、迁移代和分页工具输出在强退后读回。
- 独立资料中的四个合成会话共保存 120 份工具详情，输出合计 114,002,360 字节，四份 JSONL 合计 289,644 字节。重开存储后，四个会话均可搜索并按页读取工具详情。
- 300 轮浏览器样本覆盖空闲、流式回复、空闲中文组字、回复中中文组字。该样本没有记录到 50 ms 以上的主线程长任务。
- 普通账户的覆盖安装、降级和真实 Windows 输入法留给独立安装验收。未经用户授权不接入日常会话或真实服务。
