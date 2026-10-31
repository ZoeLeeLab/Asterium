---
{
  "name": "API 会话与手动压缩",
  "id": "asterium.api-sessions",
  "appliesTo": [
    "api"
  ],
  "protocols": [
    "deepseek-chat"
  ],
  "permissionBoundary": "会话按伙伴和会话 ID 隔离；压缩不授权执行历史工具，摘要不包含私有思考。",
  "status": "stable",
  "codeEntries": [
    "src/main/api/ApiAgentSessionStore.ts",
    "src/main/api/ApiSessionCompactor.ts"
  ],
  "tests": [
    "tests/unit/apiAgentSessionStore.test.ts",
    "tests/unit/sessionCompaction.test.ts",
    "tests/unit/apiProtocolSwitching.test.ts",
    "tests/unit/apiAutomaticCompaction.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md"
  ],
  "lastVerifiedCommit": null
}
---

API 会话与手动压缩的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
