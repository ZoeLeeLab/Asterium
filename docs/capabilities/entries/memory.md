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
    "src/main/memory/PartnerMemoryService.ts",
    "src/main/diary/DiaryGenerators.ts",
    "src/main/adapters/ClaudeCliTransport.ts"
  ],
  "tests": [
    "tests/unit/partnerMemoryToolService.test.ts",
    "tests/unit/partnerMemoryService.test.ts",
    "tests/unit/diaryGenerators.test.ts",
    "tests/unit/partnerDiaryScheduler.test.ts",
    "tests/unit/nativeProfileReload.test.ts",
    "tests/unit/nativeSessionCompaction.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/claude-cli-compatibility.md",
    "docs/data-isolation.md"
  ],
  "lastVerifiedCommit": "10437a8d41a665073d7c091ce2dc31ad805ba0ad"
}
---

伙伴记忆的当前代码入口、测试和权限边界见以上元数据。

记忆业务权限不变，Claude 调用改经官方 CLI；日记生成继续禁用工具并不保存原生会话。已有记忆导入能力仍在确认，尚未提供通用导入，不自动继承外部历史。日记、重读与压缩的合成回归不等于真实订阅通过。

本条核验绑定已存在代码提交 `10437a8d41a665073d7c091ce2dc31ad805ba0ad`，不继承旧候选验收归属。构建和人工验收分别以新候选独立报告为准；模拟、源码及配置核验不代表真实服务或普通账户验收通过。
