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
    "src/main/studio/studioWakeAdapterSdk.ts",
    "src/main/studio/WakeBridgeSession.ts",
    "src/main/studio/WakeDeliveryQueue.ts",
    "src/main/studio/WakeDeliveryStore.ts"
  ],
  "tests": [
    "tests/unit/studioWakeEvents.test.ts",
    "tests/unit/studioWakeMinimal.test.ts",
    "tests/unit/studioWakeControl.test.ts",
    "tests/studio-wake-adapter-acceptance.mjs"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/claude-cli-release-blocker.md",
    "docs/data-isolation.md",
    "docs/development-data-isolation-s1.md"
  ],
  "lastVerifiedCommit": "ccc08e5fbe9328f24b754d488892067751fdeff5"
}
---

星丛 Wake 通知与参考 SDK的当前代码入口、测试和权限边界见以上元数据。

Wake 通知、参考 SDK 与模拟合同不等于外部宿主原线程自动唤醒。

本条绑定本轮已存在代码基线 `ccc08e5fbe9328f24b754d488892067751fdeff5`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。

本轮仅修正 mock 过早把 scanCursor 当成 checkpoint 完成的等待条件，并增加延迟 checkpoint 回归；业务实现未变。原一次投递等断言保留。20 次重复 mock 已通过，不代表真实 CyberBoss 原线程验收。

## 2026-11-02 S1 未提交源码增量

本轮源码非日常启动默认禁用 Wake 自动连接，包括后续伙伴同步触发的 readiness 变化；显式手动控制保留原有权限。启动开关可明确启用本次后台恢复。没有新增 CyberBoss 宿主接线或原线程自动唤醒验收。

lastVerifiedCommit 保留原已提交基线，不代表本轮未提交实现已绑定。仅完成启动隔离与最小并行核验，不继承旧候选验收；结果与后续停点见 [S1 记录](../../development-data-isolation-s1.md)。
