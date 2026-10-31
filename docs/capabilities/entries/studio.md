---
{
  "name": "工作室与群聊",
  "id": "asterium.studio",
  "appliesTo": [
    "api",
    "local_cli",
    "existing_thread"
  ],
  "protocols": [
    "internal"
  ],
  "permissionBoundary": "群公开消息可见性由成员关系决定；内部调度与公开消息落账分离。",
  "status": "stable",
  "codeEntries": [
    "src/main/studio/StudioRoomStore.ts",
    "src/main/studio/StudioOrchestrator.ts"
  ],
  "tests": [
    "tests/unit/studioRoomStore.test.ts",
    "tests/renderer/NavigationFlows.test.tsx",
    "tests/unit/studioOrchestrator.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/release-status.md"
  ],
  "lastVerifiedCommit": null
}
---

工作室与群聊的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
