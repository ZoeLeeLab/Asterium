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
  "lastVerifiedCommit": "39122d3a15ba44f14568d6826b7dc5b590266cea"
}
---

星丛 Wake 通知与参考 SDK的当前代码入口、测试和权限边界见以上元数据。

Wake 通知、参考 SDK 与模拟合同不等于外部宿主原线程自动唤醒。

本条绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。
