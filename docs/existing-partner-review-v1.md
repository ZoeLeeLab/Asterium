# 接回伙伴的 Markdown 方案复核 v1

星丛用户在单聊明确请当前伙伴找指定的接回伙伴复核。星丛上传一份 Markdown 文件和简短的转交说明，CyberBoss 在已接回的原线程执行，结果回到发起消息下的任务卡。用户根据评审意见决定下一步。

这份契约用于对接 Sidecar 后端。星丛使用接回伙伴现有的 HTTPS 服务地址、Cookie 与 Origin。小门网页、微信、普通星丛单聊和群聊继续走各自的入口。仓库内验证使用模拟宿主，实际文件可读性和原线程回传按部署验收。

## HTTP 契约

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/asterium/reviews` | 返回 `{ "version": 1, "threadId": "synthetic-thread" }`。只有当前已认证连接已绑定可接单原线程且 v1 能力可用时才返回成功。 |
| POST | `/api/asterium/reviews` | 一次提交 `multipart/form-data`，包含 JSON 字符串字段 `metadata` 和 Markdown 文件字段 `file`。返回任务回执。 |
| GET | `/api/asterium/reviews/{requestId}` | 按原请求 ID 查回执。查询是只读的，不启动模型。 |

提交元数据示例使用合成数据。下面的 SHA-256 仅示意字段格式。正式请求以实际上传字节计算。

```json
{
  "version": 1,
  "requestId": "00000001-0000-4000-8000-000000000001",
  "threadId": "synthetic-thread",
  "message": "[星丛转交 · 来自示例伙伴]\n请评审这个方案。\n用户原话：「请找示例伙伴复核。」\n附件：proposal.md\n本次只请你给评审意见，不要修改代码。",
  "file": {
    "name": "proposal.md",
    "sizeBytes": 42,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

- 每次提交一份非空 UTF-8 `.md` 文件，最多 160,000 字节。文件名最多 180 字符且只作展示，服务端使用自己生成的落盘名称。消息最多 4,000 字符，含用户原话、简短问题、文件名及固定评审要求。Multipart 的文件部分 MIME 为 `text/markdown`。
- 回执为 JSON，字段为 `version`、`requestId`、`threadId`、`status`，以及成功时的 `result`。原样回显提交的请求 ID 和预期线程 ID，包含 `thread_changed` 回执。仅 `succeeded` 携带完整回复，长度 1 至 20,000 字符。成功和业务状态使用 HTTP 2xx。未知 ID 可以返回 404。协议字段以星丛共享 schema 为准。
- `accepted`、`running` 表示任务已接收、正在运行。`succeeded`、`failed` 表示该轮成功、失败。`busy`、`thread_changed`、`file_unreadable` 表示因忙、线程不符或文件不可读而拒绝启动。只有明确的 `busy` 允许在任务卡上手动以新请求 ID 重试。响应缺失或无法归属时，星丛只查原请求，不补发文件。

## 宿主接线与验收

- 用已认证连接的服务端绑定判断接收身份，校验预期线程、文件名、UTF-8、大小及哈希。文件落在接收伙伴可读的受限位置。把短消息和宿主生成的文件引用交给原线程，保持文件字节独立于消息正文。接收伙伴读取文件时使用原线程已有权限。
- 与同一线程的日常对话共用忙碌门控。线程切换或恢复失败要明确拒绝。持久登记请求 ID 和载荷指纹后才可启动，同 ID 同载荷返回既有回执，同 ID 不同载荷拒绝。回执归已认证的原连接，线程后续切换后仍可查询原任务，凭据撤销时拒绝访问。
- 绑定实际线程和轮次，等轮次终止再保存完整原话。复核结果用专用回执回星丛，原线程保留该轮记录，回执不走小门普通聊天广播或微信投递。Sidecar 需要确保文件至少留存到该轮结束，再按宿主附件保留策略清理。日志只记录状态与诊断标识。
- 验收用合成 Markdown 标记。校验线程输入只包含短消息与文件引用、接收伙伴能读取实际文件、原任务卡能显示多段原话。再验证忙碌、文件不可读、切换线程、断开连接、重启、重复提交和错误回执隔离。仓库内验证以模拟宿主为准，各实际部署单独验收。
