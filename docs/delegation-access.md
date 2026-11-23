# 委派任务的只读／执行提示

## 当前方案

按用户确认，接回伙伴继续使用已有 v1 接口和原线程。星丛只在 message 中追加一句本次任务要求，不新增接收端字段，不要求升级服务器、修改 Codex 配置或实现新的沙箱与审批。

- read：`本次权限：read（只读）。只查看和反馈，不修改文件、不部署或执行变更。`
- write：`本次权限：write（可执行）。请按用户授权完成任务，沿用你当前的权限和审批。`

这是模型需要遵守的任务指令，read 不构成服务器执行层的强制只读隔离，write 也不授予接收伙伴原本没有的权限。实际执行继续受接收线程既有配置约束；接收端已有的审批拒绝等行为不会被这句话改变。本轮没有修改或部署接收端，也没有进行真实服务器执行验收。

## 星丛侧处理

1. 发起伙伴依据用户本轮要求选择工具参数 `access: read | write`；省略时默认 read。星丛不按“部署”等关键词自动推断。
2. Main 检查发起会话，拒绝只读／Plan 发起 write；排队任务真正发送前再次检查来源是否已变为只读／Plan。模型不能传入或改写这个会话配置。
3. Main 根据 access 生成上述一句话，与任务要求、用户原话、附件文件名共同放入现有 message。附件仍作为独立 Markdown 文件上传，保留字节快照、SHA-256 与原线程绑定。
4. 普通本地/API 一次性委派保持只读和现有工具限制。本轮不开放它们的 write 执行。
5. 请求、附件、结果和重启恢复继续沿用既有队列；回执缺失只查原请求 ID，不重新发送可能已经执行的任务。明确 busy 后的手动重试保留同一任务要求和文件快照。

伙伴名单中的 accessModes 是星丛可传递的任务提示类型，不是接收端声明了工具级权限。既有 Codex 原生线程仍保留创建时的工具说明，本轮没有升级旧线程工具清单；未传 access 时继续按 read 处理。

## HTTP 接口保持 v1

能力响应仍为 `{ "version": 1, "threadId": "synthetic-thread" }`。POST 的 metadata 仍严格只包含 version、requestId、threadId、message、file；没有 access、permission、execution 或 permissionMode 字段。

回执仍只有 version、requestId、threadId、status，以及成功时的 result。完整字段与原有状态见 [v1 接口说明](existing-partner-review-v1.md)。接收端无需为本次任务提示适配 v2；未发布的两版 v2 草案已从当前代码撤回，不做并行兼容。

## 验证记录

此前两版实现和原始验证日志保留在 Git 及本地独立记录中，均未打包发布，不能当作当前提示词方案的验收：

| 历史阶段 | 代码提交 | 对应完整回归 |
| --- | --- | --- |
| execution/permissionMode 草案，已撤回 | `2cf0ad7967eadd816b01b0498df939e78aef67f6` | 289 个文件、2062 项通过，1 项跳过、2 项 TODO |
| 单个 permission 字段草案，已撤回 | `12f3b38a91872feec0d4529870f4eeafe34ca3c6` | 289 个文件、2063 项通过，1 项跳过、2 项 TODO |

2026-11-23 当前提示词方案的代码基线为 `6889c9e1849e1fb65f0c1fe7f534184f9b070bc5`，能力条目绑定该已存在的代码提交，随后追加纯文档核验提交。

- 使用原 v1 模拟宿主验证，8 个相关测试文件、74 项通过，覆盖两种提示、默认 read、只读／Plan 检查、严格无新增字段、附件上传、错误回执、重启查询和忙碌重试。合成 ID 规范化后，相关 9 项另行重跑通过。
- 完整回归 289 个测试文件、2060 项通过，1 项既有跳过、2 项既有 TODO。执行命令为 `npx vitest run --config .qa/delegation-access-vitest.config.ts --maxWorkers=4 --testTimeout=15000`，该忽略的临时配置只用于独立工作树的共享依赖加载；正式测试配置未改。日志独立保存为 `.qa/delegation-prompt-only-full-20261123-v1.log`。
- Typecheck 通过，lint 0 错误、15 项既有警告；正式能力检查 16 条通过；隐私扫描 902 个文件、0 项发现；git diff --check 通过。产品代码与完整回归时一致，HTTP schema 与远端 main 基线 `f633acdc2d06d03d8553d722ce58d77dd43d2d9d` 完全一致。

当前继续使用独立分支 `codex/feat-delegation-access-20261123`。本轮不修改其他拆分或委派回传工作树，不打包、推送、合并 main 或部署服务器。测试只用合成资料和模拟宿主；保留此前原始验收日志。
