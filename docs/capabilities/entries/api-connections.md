---
{
  "name": "共享 API 连接与模型配置",
  "id": "asterium.api-connections",
  "appliesTo": [
    "api"
  ],
  "protocols": [
    "chat_completions",
    "responses",
    "anthropic_messages",
    "gemini"
  ],
  "permissionBoundary": "Main 管理凭据引用及配置；共享引用保护不改变伙伴工具权限或群成员资格。",
  "status": "experimental",
  "codeEntries": [
    "src/main/api/ApiConnectionStore.ts",
    "src/renderer/components/settings/ApiPartnerConnectionFields.tsx",
    "src/shared/apiPresets.ts",
    "src/main/api/listApiSiteModels.ts",
    "src/shared/apiConnections.ts",
    "src/main/agentIpc.ts"
  ],
  "tests": [
    "tests/unit/apiConnectionStore.test.ts",
    "tests/renderer/ApiConnectionsSettings.test.tsx",
    "tests/unit/apiSiteModels.test.ts",
    "tests/unit/desktopIpc.test.ts",
    "tests/api-providers-acceptance.mjs"
  ],
  "docs": [
    "docs/release-status.md",
    "docs/api-connections-guide.md"
  ],
  "lastVerifiedCommit": null
}
---

共享 API 连接与模型配置的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
