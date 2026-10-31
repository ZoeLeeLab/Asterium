---
{
  "name": "外部伙伴群聊 MCP",
  "id": "asterium.studio-mcp",
  "appliesTo": [
    "existing_thread",
    "external_mcp"
  ],
  "protocols": [
    "mcp"
  ],
  "permissionBoundary": "凭据固定绑定伙伴，逐次校验成员资格和代次；撤销后立即失效。",
  "status": "stable",
  "codeEntries": [
    "src/main/studio/StudioMcpService.ts",
    "src/main/studio/StudioMcpTools.ts",
    "src/main/studio/StudioMcpHost.ts"
  ],
  "tests": [
    "tests/unit/studioMcp.test.ts",
    "tests/unit/studioExternalRoom.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md"
  ],
  "lastVerifiedCommit": null
}
---

外部伙伴群聊 MCP的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

发布整理已移除预置演示资料和私人迁移入口。本副本尚未建立代码基线；`lastVerifiedCommit: null` 表示待核验，不能视为已绑定提交或沿用旧候选验收。新基线提交存在后，应完成核验并追加纯文档提交。
