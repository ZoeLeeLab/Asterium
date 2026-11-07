---
{
  "name": "伙伴接入",
  "id": "asterium.partners",
  "appliesTo": [
    "local_cli",
    "api",
    "existing_thread"
  ],
  "protocols": [
    "codex-cli",
    "claude-cli",
    "deepseek-chat",
    "cyberboss-bridge"
  ],
  "permissionBoundary": "原生宿主权限与星丛审批并行生效；手动命令等待允许，Full 授权当前 Windows 账户权限，不提供任意原生命令的操作系统级文件隔离。只读、取消、会话归属和一次性审批仍校验。现有线程须明确绑定。",
  "status": "experimental",
  "codeEntries": [
    "src/main/adapters/CodexCliAdapter.ts",
    "src/main/adapters/ClaudeCodeAdapter.ts",
    "src/main/adapters/ExistingThreadAdapter.ts",
    "src/main/adapters/CyberBossBridgeClient.ts",
    "src/main/api/ApiProviderRegistry.ts",
    "src/main/adapters/ClaudeCliTransport.ts",
    "src/main/adapters/claudeStdioProxy.cjs",
    "native/claude-bridge/ClaudePipeHost.cs"
  ],
  "tests": [
    "tests/unit/codexCliAdapter.test.ts",
    "tests/unit/claudeCodeAdapter.test.ts",
    "tests/unit/existingThreadAdapter.test.ts",
    "tests/renderer/AgentChatFlows.test.tsx",
    "tests/unit/apiProviderRegistry.test.ts",
    "tests/unit/claudeCliBootstrap.test.ts",
    "tests/unit/claudePlanRevision.test.ts",
    "tests/claude-cli-acceptance.mjs"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/claude-cli-compatibility.md",
    "docs/claude-cli-release-blocker.md"
  ],
  "lastVerifiedCommit": "106b5506be670d43f97ef85ff8c4d3d424834a55"
}
---

伙伴接入的当前代码入口、测试和权限边界见以上元数据。

Claude 改为未修改官方 CLI，MCP 使用 stdio，经账户和当前 CLI 进程树绑定的本机 IPC 调用主进程业务与审批。原生工具显式 ask，路径检查与卡片归属为主，Hooks 仅为额外防线；无 SDK 回退或产品 HTTP 桥接。真实订阅仍待验收，版本支持以 Windows 合成服务实测报告为准，不推断更高版本。

上述 Claude 核验绑定已存在代码提交 `2b084045c0f923bba54127d0cb3366a730df55f5`，不继承旧候选验收归属。构建和人工验收分别以新候选独立报告为准；模拟、源码及配置核验不代表真实服务或普通账户验收通过。

官方 CLI 合成回归还覆盖明确 session ID 恢复及部分流事件；不等于真实订阅已验收。

维护者已明确 Full 的原生账户权限。前次编码路径观察及失败报告作为历史保留，当前验收按手动允许／拒绝、Full 放行、只读拒绝及桥接归属执行；不新增 Claude 沙箱。

CLI 子进程单独关闭后台自更新，不更改用户全局设置，仍由用户维护官方版本；真实订阅验收独立记录。

## 单聊与群聊的一次性上下文交接（当前工作区）

用户可将近期勾选的文本原话带到同一伙伴的单聊或群聊。主进程按来源消息 ID 核对并读取原文，只随目标伙伴下一轮发送。交接卡只保存在内存，群聊按实际发言队列将其交给选定的 API 或本地 CLI 伙伴。接收运行确认接手后清除草稿。交接正文不进入群聊公共消息或星丛长期记忆，原生线程可能保留已接收的输入。外部线程暂未接入。当前工作区入口为 `src/main/runtime/ContextHandoffService.ts`，模拟验收覆盖来源筛选、群聊私有分发、API 历史排除与原话选择。

## CyberBoss 单聊后续回复（当前工作区）

脱敏回放中，用户事件带有 `clientMessageId`，工具前后的两条回复均缺少轮次 ID，之后也没有终态。

星丛在首条回复到达后释放本地发送状态，并继续消费同一 SSE 游标。后续文本回复在原单聊独立显示，按 SSE ID 去重。带有相同 `clientMessageId` 的原提问回显会保留当前回复路由。收到其他用户消息、无法关联的用户回显或线程切换时，会结束旧回复路由。无需修改 CyberBoss SSE 协议。桥接重连和界面追加已通过合成回归，真实外部伙伴仍待开发版联调。

## CyberBoss 单聊发送图片和普通文件

已连接的接回伙伴支持 JPG、PNG、WebP 和 GIF，单张至多 10 MiB，一次最多 4 张。报告普通文件 v1 能力的宿主还支持 MD、TXT、CSV、JSON、PDF、DOCX、XLSX、PPTX 和 ZIP，单件至多 20 MiB。每条消息附件合计最多 10 件、50 MiB，其中图片仍最多 4 张。实际可选类型和限额受宿主能力约束。旧宿主仍可发送图片和文字。

超过 20 MiB 的普通磁盘文件作为「本地引用」随单聊文本传递原路径。接回伙伴用已有的文件访问方式打开该位置，文件内容留在原处。

主进程读取本轮已提交的对话快照，经现有会话鉴权分别上传图片和普通文件原始字节。含普通文件的消息将附件引用、正文、绑定线程 ID 和消息幂等 ID 一起原子提交。允许无正文或图文文件混发。上传失败时停止提交。传输结果不明时，客户端最多使用同一份请求重试一次。已发送的附件可以从本地快照预览或另存。当前范围是星丛单聊发给伙伴。仓库核验使用合成宿主，覆盖纯图片、纯文件、混发、线程切换和幂等重试。


## 本机 Codex 单聊模型切换（当前工作区）

在单聊右侧伙伴卡的「选择模型」和「思考强度」中调整 Codex。模型列表由该伙伴已绑定的运行环境提供。选择按对话保存，从下一条消息起使用，并在同一个原生线程续聊。正在运行的轮次保留开始时的选择，计划修订和确认执行沿用这份选择。
