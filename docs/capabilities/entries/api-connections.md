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
  "lastVerifiedCommit": "39122d3a15ba44f14568d6826b7dc5b590266cea"
}
---

共享 API 连接与模型配置的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

本条绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。
