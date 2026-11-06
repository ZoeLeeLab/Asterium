# 外部伙伴群唤醒最小契约 v2

本文件替代此前 v1 的完整触发 HTTP 控制面、持久任务状态机及熔断重连设计。服务器代码/服务没有由本任务修改；真实接线需另一个明确获授权的任务实施。本仓库提供可导入参考 SDK、模拟验收和星丛侧控制入口。

## 连接链路

星丛启动（通知服务就绪后）或用户点击“重新连接” → 现有小门的轻量控制动作 → 服务器 Bridge 建立一次到星丛 `/wake/events` 的 SSE。

群消息提示 → 这条 SSE → CyberBoss 专用内部入口 → 宿主原线程队列 → 外部伙伴通过现有群聊 MCP 读取/回复/确认。

复用小门原有 HTTPS、Cookie、Origin 校验，不新增服务或端口。不使用 `/api/messages`，不产生用户聊天消息。小门本身的单聊 SSE 恢复、微信链路和群聊 MCP 工具保持原有行为。它们重新登录或恢复网络不能顺带启动新的群 Wake 连接。

## 单次连接

- SDK `WakeSingleConnection`：每个新的显式启动请求最多一个 HTTP/SSE 建连尝试。连接中/已连接时重复请求忽略；失败后的同一 requestId 也不再尝试，用户新操作使用新 ID。
- **仅建立 SSE 连接有 8 秒超时**，收到合法响应头后清除计时器。连接成功后不设置读空闲超时；长时间没有消息或心跳也不主动重连。
- 正常服务端心跳仅维持现有连接，不触发模型。真实 EOF、网络/协议错误停止；无自动重连、退避、熔断、半开、watchdog 或 supervisor 重启唤醒桥。
- 宿主进程可以沿用自身的服务管理，但重启后 WakeSession 必须保持 stopped，等待新的星丛启动或人工连接信号。
- `/wake/events` 使用现有星丛 MCP Bearer；凭据留在服务器受保护配置。启动控制中不传令牌、任意目标 URL 或线程 ID。

## 复用小门的唯一新增控制路由

`POST /api/asterium/wake/control`，使用原有 Cookie 与 Origin 验证。服务端通过已认证用户及固定 `connectionBindingId` 查预配置的伙伴、星丛 Origin 和原线程绑定。不能允许参数任意填写发送者、目标主机或线程。

请求由 `studioWakeControlRequestSchema` 定义：

```json
{
  "protocolVersion": 2,
  "source": "asterium",
  "action": "connect_once",
  "requestId": "00000002-0000-4000-8000-000000000001",
  "connectionBindingId": "server-configured-binding"
}
```

action：connect_once 建连一次；status 只读状态；retry/ignore 需要原 triggerId；resume 恢复配额暂停，不能绕过一分钟预算。整个控制动作不作为用户聊天消息，不直接调用模型；retry 仅为用户明确授权的投递动作。

回复由 `studioWakeControlReplySchema` 定义：原 requestId/connectionBindingId、连接阶段 stopped/connecting/connected、duplicate、可选配额/容量暂停及最多 64 项人工待确认。不能返回凭据或私聊正文。

SDK `WakeBridgeSession.control()` 提供进程内去重和参考实现；服务器每个固定 binding 只保留一个实例，重复控制请求复用同一 Promise/结果。状态查询不建连、不调用模型。旧 `/api/asterium/adapter`、`/api/asterium/triggers` 不是本期接口。

## 星丛控制入口

「设置 → MCP 管理 → 群聊自动唤醒」默认折叠。选择已接回伙伴，填写服务器任务提供的 connectionBindingId；登录使用该伙伴既有的小门凭据，不另存一份密钥。绑定只存伙伴 ID、connectionBindingId 和 connectOnLaunch。

勾选「星丛启动后连接一次」时，新绑定或下一次应用启动会登记一次意图。等现有群聊 MCP 已开启、私网地址及该伙伴有效凭据就绪，再发送一次 connect_once。MCP 会恢复上次保存的开启状态，手动停用后保持停用；Wake 不覆盖这个选择。配置同步、小门认证恢复、watch 重连及短暂网络恢复不重复发送；失败也消耗本次启动意图。

「重新连接群唤醒」是一次新的显式操作；「刷新唤醒状态」只发送 status，不顺带重连或投递。显示最近一次快照，不用轮询调用模型或网络。投递未知项按群显示「重试／忽略」，quota 暂停需人工恢复；pending_limit 需重新连接同步。

控制 HTTP 请求有 8 秒回执期限（包含登录），超时只标记请求结果无法确认、不补发。它与 SSE 建立连接的 8 秒期限是两个请求；控制请求结束不取消已建立的服务器 SSE。401 会沿用现有小门会话逻辑重新认证一次，以同一 requestId 再请求；网络错误、404/405 等不重试。服务器接口尚未安装会明确显示未支持，不回退到聊天发信。

## 内部注入与原线程

`WakeBridgeSession` 接受宿主提供的 `WakeEnqueuePort.enqueue(trigger, signal)`。它必须**进入 CyberBoss 自己的原线程队列**，及时返回 `{accepted, triggerId}`；accepted 表示宿主明确接收进入队列，不代表模型结束。不等待模型终态或 MCP ACK，也不由 Bridge 维护第二套原线程执行锁。

宿主必须：固定原线程并校验独立 threadBindingGeneration；与单聊、审批、其他内部工作共用忙碌门控；排队后启动前重新核验群成员代次与发言资格；恢复失败拒绝，不自动新建线程；专用 source=asterium，不能冒充微信入站，不能将最终输出回显微信或小门。公开群回复由现有 MCP 发送。

保留 `studioWakeEnvelopeSchema` 作为内部信封 schema（v2）。到 Codex 底层用文本 turn 承载提醒是允许的，CyberBoss 入口类型和输出路由仍必须明确区别于用户的微信消息。不能裸用 app-server injector 绕过宿主队列/回复路由。

signal 只取消等待投递回执，不能终止已经运行的原线程模型。8 秒没有明确投递回执时进入该项人工确认；这**不是 SSE 读空闲超时，不断开 SSE**。

## 最小持久化与人工处理

`WakeDeliveryStore` 只存：扫描通知游标；按群/成员代次的处置通知游标；该群最后成功交付的 eventId/triggerId。无 active、pending、模型执行状态、重试计数或凭据。群 A 未知不会被群 B 的成功覆盖。

`WakeDeliveryQueue` 仅在内存中合并：2 秒窗口、每分钟最多 6 次投递、最多 64 个群。宿主接受后立即记录成功，不等待模型回复或处理确认。普通伙伴回复不唤醒其他伙伴，自由讨论中的明确邀请沿用现有规则。

投递结果不明：只隔离该群，显示“重试／忽略”，不自动重试模型。其他群可继续交给宿主；原线程实际忙碌时仍须排队。重试沿用原 triggerId；忽略只推进通知处置位置，不删消息、不代替 MCP ACK。请求/触发 ID 的去重为进程内尽力去重，不承诺跨崩溃精确一次。

投递前先持久扫描位置。重启后从每群未处置位置回放，旧未确认提醒保守交人工，包括部分实际尚未投递的提醒。触发 ID 根据固定 Adapter、群、成员代次、消息边界稳定生成。日志缺口/reset 使用当前权威提示重建人工待办；不盲目自动补投旧提醒。新通知继续正常自动处理。

权限、公开历史和处理位置以星丛 MCP/ledger 为准。通知处置游标与公开消息 seq、MCP 处理确认三者不能混用。超出容量保留 ledger 和游标，人工重新连接同步，不静默丢消息。

## SDK 与验收

```sh
npm run build:studio-wake
npm run test:studio-wake-adapter
```

复制 SDK 时同时携带 `out/studio-wake-adapter/LICENSE-ZOD.txt`。服务器任务可导入 WakeBridgeSession/WakeDeliveryStore 和 schema，提供自己的固定线程 enqueue 实现；不需要新建独立 HTTP 触发服务。

服务器端点就绪后，环境中设置既有小门凭据 `CYBERBOSS_WEB_SECRET`，配置示例见 `examples/studio-wake-adapter.binding.json`。默认 status 只读，不发连接信号：

```sh
node tests/studio-wake-adapter-acceptance.mjs --config /path/to/binding.json
```

显式建立一次连接：加 `--connect`。人工处理单项：`--retry TRIGGER_ID` 或 `--ignore TRIGGER_ID`。这些操作不可由 supervisor/定时器循环执行；网络回执不明不自动重新发新的动作。

真实验收：原线程 ID 前后一致、忙碌时串行、群内回复且微信无回显；重复启动只建一次；静默/正常心跳不超时；断网/EOF 后不重连，星丛重启或手动连接才再尝试；A 群未知时 B 群继续排队；人工忽略不推进 MCP 处理确认；重启后旧未知提醒人工处理。模拟通过不等于真实外部伙伴自动唤醒已通过。

服务器任务完成后的人工步骤：

1. 记录外部伙伴原线程 ID；打开群聊 MCP，保持原有凭据有效。进入群聊自动唤醒卡片，填服务器绑定 ID，按需要勾选启动连接并保存，点击刷新核对 connected。
2. 在只有用户与外部伙伴的测试群发送唯一标记，不再通过微信或小门提醒；确认外部伙伴在该群回复、原线程不变、微信与星丛单聊不出现自动回显。
3. 原线程忙碌时再发群消息，确认宿主串行排队；静默超过 8 秒后刷新仍为 connected，心跳不启动模型。
4. 让测试 SSE 发生真实 EOF 或网络错误；恢复网络后先刷新，应保持 stopped。点击重新连接才建立一次，重复启动信号不创建第二条活动 SSE。
5. 在隔离测试条件下制造 A 群投递回执丢失，核对 A 显示人工重试/忽略，B 群仍能继续；重试沿用 triggerId，忽略不改 MCP 处理确认。应用/桥重启后旧未处置提醒保守交人工。

现阶段只需本地自动验收；这些真实宿主步骤要等服务器授权任务交付后执行，不能用当前模拟结果替代。
