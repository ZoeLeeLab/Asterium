# 委派任务权限

## 目标与实现边界

任务由发起伙伴按用户的实际要求选择 `access: read | write`。工具调用省略 access 时按只读处理，星丛不根据“部署”等关键词自动选择权限。星丛只保留只读／Plan 会话不能派出 write 的检查，不向接收伙伴传递 manual/automatic/full 等发起方审批配置。write 的执行权限和审批沿用接收宿主原有配置，仍须遵守用户授权的任务与目标范围。附件可作为用户指定的实施资料，不能自行增加授权。

本轮从远端 main `f633acdc2d06d03d8553d722ce58d77dd43d2d9d` 创建独立分支和工作树。委派回传分支中的待提交修改与既有验收包保持原状。本轮不改界面，不修改其他拆分工作树，不部署外部宿主。

## 数据流与职责

1. `PartnerDelegation.ts` 校验任务的 access 并持久保存；旧任务没有字段时按 read 解释。
2. Main 从真实发起命令获取原会话状态，拒绝只读或 Plan 发起 write；模型不能传入发起会话的配置。
3. `DelegationAccess.ts` 负责权限判断、宿主能力协商与提示词，不在 IPC 中堆叠业务规则。
4. 接回伙伴先查询已认证宿主的能力。v1 保留原有 Markdown 复核；v2 只传 permission: read/write，请求与回执必须匹配。write 不降级成 v1 复核。
5. 排队执行前再次校验当前来源会话与目标宿主。来源变为只读／Plan 时拒绝启动 write；manual/automatic/full 之间变化不再改变接收端的审批。丢失回执只查询原 ID，不重发执行。
6. 普通本地/API 一次性委派目前仍只读、无执行工具；名单如实声明只支持 read，write 返回明确不支持。

## 外部宿主 v2 契约

沿用 `/api/asterium/reviews` 的认证、文件上传、请求 ID、线程绑定、去重与查询流程。

- 能力：`{ version: 2, threadId: "synthetic-thread", permissions: ["read", "write"] }`。
- 请求：保留 v1 的 requestId/threadId/message/file；version 为 2，仅增加 `permission: "read" | "write"`。不携带 execution 或 permissionMode。
- 回执：回显 version、requestId、threadId、permission；其余状态及 result 规则沿用 v1。不得把 v2 回执降级为 v1，也不能用不匹配的 permission 确认成功。
- 接收宿主负责单轮运行：read 强制只读沙箱并禁止权限升级；write 沿用接收线程既有的执行权限及审批。本轮结束后不改变普通对话配置。可继续使用已有审批通道；不能提供必要审批时返回 `approval_required`，权限不足返回 `permission_denied`，不能默认批准或静默当作成功。
- permission 属于载荷指纹的一部分；同 ID 改权限必须拒绝。宿主升级后仍接收 v1，将新的 v1 复核任务按 read 执行，同时保留旧任务查询。

这份简化契约替换未发布的 execution/permissionMode 版 v2 草案；此前源码提交和验证记录保留在 Git，不增加两套 v2 并行兼容逻辑。已发布的 v1 字段和原线程绑定保持兼容。模型工具参数仍叫 access，伙伴名单仍用 accessModes；这两个是星丛内部工具约定，发送到接收端时只映射为 permission。

可直接交给接收端对接的合成例子：

```json
{
  "version": 2,
  "requestId": "00000001-0000-4000-8000-000000000001",
  "threadId": "synthetic-thread",
  "message": "请按用户授权处理附件中的合成示例。",
  "file": {
    "name": "example.md",
    "sizeBytes": 12,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "permission": "write"
}
```

该 metadata 仍与实际 Markdown 文件字节一起上传；示例大小和哈希仅示意格式。成功回执：

```json
{
  "version": 2,
  "requestId": "00000001-0000-4000-8000-000000000001",
  "threadId": "synthetic-thread",
  "permission": "write",
  "status": "succeeded",
  "result": "合成任务已完成。"
}
```

星丛客户端支持不代表外部宿主已经接线，实际读写和部署必须用明确指定的合成测试连接另行验收。不能仅凭提示词宣称强制只读或服务器部署已生效。

v1 是历史复核约定，只有提示词和既有宿主策略，没有 v2 的结构化权限回显；不把它描述成已验收的工具级强制只读。Codex 新线程会注册新增的 access 参数；既有原生线程仍使用创建时的工具清单，本轮不迁移或重建原线程。旧清单不能因此被宣称已支持选择 write，需在后续原生工具升级中单独处理。

## 初版验证记录

- 8 个相关测试文件、76 项通过，覆盖父会话权限矩阵、宿主能力协商、v1/v2 上传、写任务重启后的同 ID 查询、权限回显不符与宿主拒绝。
- Typecheck 通过；lint 为 0 错误、15 项既有警告；隐私扫描 902 个文件、0 项发现；git diff --check 通过。
- 首次专项运行因独立工作树的依赖目录链接触发 Vite 依赖资源加载限制。仅在忽略的 `.qa` 临时测试配置中允许实际依赖目录，正式配置和产品权限未改动，重跑通过。
- 首次全套运行在能力词典核验处停止：1789 项通过，1 项失败；失败原因是两个新增代码文件尚不存在于历史 lastVerifiedCommit。该检查保持原规则，此次失败记录保留，不描述为通过。
- 经用户授权提交代码基线并绑定实际 SHA 后，全套回归通过：289 个测试文件、2062 项通过，1 项既有跳过、2 项既有 TODO。运行命令为 `npx vitest run --config .qa/delegation-access-vitest.config.ts --maxWorkers=4 --testTimeout=15000`，本地独立验证日志保存在 `.qa/delegation-access-full-2cf0ad7.log`。
- 绑定后正式 `check:capabilities` 的 16 条检查通过；Typecheck、lint（0 错误、15 项既有警告）、隐私扫描（902 个文件、0 项发现）及 git diff --check 均通过。运行代码与基线提交一致。

以上验证对应初版代码基线 `2cf0ad7967eadd816b01b0498df939e78aef67f6` 和文档提交 `306dbd483f0b324bcfd6a5aef162502d2c741d9a`，不代表简化契约已经验证。原验证日志不修改。

## 简化契约增量

2026-11-23 用户确认只传 read/write，接收端自行负责执行及审批，星丛保留只读限制检查。简化代码提交为 `12f3b38a91872feec0d4529870f4eeafe34ca3c6`，位于同一独立分支 `codex/feat-delegation-access-20261123`；能力条目绑定该实际代码基线，随后追加纯文档核验提交。

- 8 个相关测试文件、77 项通过；验证默认 read、明确 write、来源只读／Plan 拒绝、无审批档位外传、严格 v1/v2 字段，以及回执权限不符、重启查询与忙碌重试保留权限。
- 全套回归 289 个测试文件、2063 项通过，1 项既有跳过、2 项既有 TODO。命令仍使用上文的独立工作树测试配置，日志单独保存在 `.qa/delegation-simple-permission-full-20261123-v1.log`，没有覆盖初版日志。
- Typecheck 通过；lint 0 错误、15 项既有警告；正式能力检查 16 条通过；隐私扫描 902 个文件、0 项发现；git diff --check 通过。最终代码与全套回归时的代码一致。

本次使用合成资料和模拟宿主，没有调用真实模型、修改服务器或替接收端实现沙箱及审批。其他拆分与委派回传工作树保持原状，未打包、推送或合并 main。
