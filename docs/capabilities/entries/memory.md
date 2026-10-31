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
  "lastVerifiedCommit": "39122d3a15ba44f14568d6826b7dc5b590266cea"
}
---

伙伴记忆的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

本条绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。
