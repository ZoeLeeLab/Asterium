# 外部自动化 Adapter v1（参考交付，宿主未接线）

本地伙伴是本地伙伴，使用星丛现有 Claude/Codex 运行器；外部伙伴是外部伙伴。此文只定义星丛与外部宿主的协议，不表示 CyberBoss 已实现。当前星丛明确禁止外部定时派发，须另开经用户授权的 CyberBoss 接入任务后再接线；普通小门、微信与群聊 MCP 路径保持原语义。

## 构建与能力

运行 `npm run build:automation-adapter`，交付 `out/automation-adapter/`、`tests/automation-adapter-acceptance.mjs`、`examples/automation-adapter.binding.json`。SDK 为 Node 22+ ESM，无服务器监听、真实凭据、模型调用或自动重连代码。`npm run test:automation-adapter` 只验证本机模拟宿主，不调用模型。

宿主必须显式声明 v1、原线程、串行、权限保留、无公开回显及持久防重；缺少任一能力，不能自动降级到普通 `/api/messages`、微信或新线程。网络拓扑沿用已授权的私网连接，不因本文新开公网端口。具体受认证控制入口由宿主任务审计后确定，不能凭参考 SDK 假定已存在端点。

## dispatch / status / cancel

类型在 `src/shared/automationAdapter.ts`。内部触发必须包含 `source=asterium`、`type=asterium.automation`、稳定 triggerId（对应星丛本次 run ID）、occurrenceId、automationId、计划时间、名称、任务内容及准确 binding；固定 `delivery=original_conversation_only`、`allowNewThread=false`、`echoToWeChat=false`。

binding 包括 adapterId、partnerId、conversationId、nativeThreadId、bindingGeneration、workspaceSignature；群任务另带 projectId、roomId、membershipGeneration，身份与成员代次分别校验。所有身份来自已认证配置，不信任请求自己声明身份。dispatch 前和真正启动前均重新验证撤销、群资格、目录授权和原线程；同一物理线程的普通聊天、Wake、自动化共用宿主串行队列。

星丛先持久占位；宿主也先持久记录触发指纹再启动模型。同 ID 同载荷只返回已有状态，不重复启动；同 ID 不同载荷拒绝。原线程忙碌时返回可辨识 busy，不能偷偷另开线程。未开始的任务可安全保留排队；已经提交到宿主但收据未知时，星丛进入 uncertain，禁止自动重新 dispatch。status 是无模型只读查询，不能引起重启任务；鉴权或绑定撤销停止访问。

accepted 只代表接收，running / waiting_approval / succeeded / failed / cancelled / uncertain 由真实宿主事件决定。取消请求接受不等于任务已取消；只有真实取消终态才落 cancelled。断线和重启之后，未能核实的 in-flight 进入 uncertain，人工确认或明确重试；已完成回执不回退。结果返回原星丛会话，带自动化来源；不走微信出站，不公开原线程私聊。

`AutomationAdapterSession` 是持久防重参考，初始化时调用 recover；host.start 必须使用已绑定原线程、复用真实宿主锁与审批，返回准确运行 ID；真实事件调用 record。未知任务默认不继续启动，必须由宿主审计、核实及人工处理。SDK 不替宿主管理目录权限或确认消息来源。

## 独立验收步骤

1. 宿主任务只读审计实际 CyberBoss／小门接入点，确认专用触发与所有输出路由；不改现有普通消息语义。
2. 实现受认证的 AdapterPort（capabilities/dispatch/status/cancel）及一个导出 `createAutomationAdapter(binding)` 的本地验收模块，配置中不含明文私钥。
3. 先执行 `node tests/automation-adapter-acceptance.mjs --host-module <模块路径> --binding <脱敏绑定文件>`，只检查能力，不调用模型。脚本不自动寻找配置或读取凭据。
4. 用户明确同意真实测试后追加 `--dispatch` 发起一次“仅回复、不修改文件”的测试，再通过宿主 status 和真实日志验证完成。输出只报告接收状态，不宣称真实验收通过。
5. 人工验证同一原线程、忙碌串行、审批、取消、重启结果未知、幂等、撤销即时失效、回复留在原会话且微信无回显；通过后星丛另行接线并做端到端验收。

当前停点：星丛参考 SDK 与模拟合同可交付；CyberBoss 入口、真实外部伙伴运行和自动化结果回传尚未验证，星丛外部执行保持关闭。
