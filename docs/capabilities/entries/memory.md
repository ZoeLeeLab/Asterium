---
{
  "name": "伙伴记忆",
  "id": "asterium.memory",
  "appliesTo": [
    "api",
    "local_cli"
  ],
  "protocols": [
    "internal"
  ],
  "permissionBoundary": "记忆按伙伴隔离，工作区权限不自动授予记忆访问；规划会话等场景有额外限制。",
  "status": "stable",
  "codeEntries": [
    "src/main/memory/PartnerMemoryToolService.ts",
    "src/main/memory/PartnerMemoryService.ts"
  ],
  "tests": [
    "tests/unit/partnerMemoryToolService.test.ts",
    "tests/unit/partnerMemoryService.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md"
  ],
  "lastVerifiedCommit": null
}
---

伙伴记忆的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
