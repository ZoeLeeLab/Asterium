---
{
  "name": "伙伴接入",
  "id": "asterium.partners",
  "appliesTo": [
    "local_cli",
    "api",
    "existing_thread"
  ],
  "protocols": [
    "codex-cli",
    "claude-agent-sdk",
    "deepseek-chat",
    "cyberboss-bridge"
  ],
  "permissionBoundary": "原生宿主权限和星丛授权并行生效；现有线程必须明确绑定，不代表支持任意中转站。",
  "status": "stable",
  "codeEntries": [
    "src/main/adapters/CodexCliAdapter.ts",
    "src/main/adapters/ClaudeCodeAdapter.ts",
    "src/main/adapters/ExistingThreadAdapter.ts",
    "src/main/api/ApiProviderRegistry.ts"
  ],
  "tests": [
    "tests/unit/codexCliAdapter.test.ts",
    "tests/unit/claudeCodeAdapter.test.ts",
    "tests/unit/existingThreadAdapter.test.ts",
    "tests/unit/apiProviderRegistry.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md"
  ],
  "lastVerifiedCommit": null
}
---

伙伴接入的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
