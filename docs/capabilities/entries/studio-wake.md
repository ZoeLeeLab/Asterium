---
{
  "name": "星丛 Wake 通知与参考 SDK",
  "id": "asterium.studio-wake",
  "appliesTo": [
    "external_adapter"
  ],
  "protocols": [
    "sse",
    "internal-http"
  ],
  "permissionBoundary": "仅发最小通知，消息正文仍通过授权 MCP 获取；连接控制不启动模型。",
  "status": "stable",
  "codeEntries": [
    "src/main/studio/StudioWakeEvents.ts",
    "src/main/studio/StudioWakeStream.ts",
    "src/main/studio/studioWakeAdapterSdk.ts"
  ],
  "tests": [
    "tests/unit/studioWakeEvents.test.ts",
    "tests/unit/studioWakeMinimal.test.ts",
    "tests/unit/studioWakeControl.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md"
  ],
  "lastVerifiedCommit": null
}
---

星丛 Wake 通知与参考 SDK的当前代码入口、测试和权限边界见以上元数据。

Wake 通知、参考 SDK 与模拟合同不等于外部宿主原线程自动唤醒。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
