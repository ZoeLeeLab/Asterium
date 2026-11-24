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
    "src/main/api/ApiSessionCompactor.ts",
    "src/main/runtime/MessageRuntime.ts",
    "src/main/runtime/RuntimeRunHooks.ts",
    "src/main/runtime/SessionMaintenanceRuntime.ts"
  ],
  "tests": [
    "tests/unit/apiAgentSessionStore.test.ts",
    "tests/unit/sessionCompaction.test.ts",
    "tests/unit/apiProtocolSwitching.test.ts",
    "tests/unit/apiAutomaticCompaction.test.ts",
    "tests/unit/runInteractionIpc.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/agent-ipc-final-service-extraction.md",
    "docs/agent-ipc-final-service-granularity.md",
    "docs/agent-ipc-final-service-verification-20261124.md"
  ],
  "lastVerifiedCommit": "4ed57df4cab29444a48ad9f8b128e1dbc0ad5045"
}
---

API 会话与手动压缩的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

本条绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。

最终业务辅助逻辑收尾的源码与合成回归核验绑定 `4ed57df4cab29444a48ad9f8b128e1dbc0ad5045`。模块归属与颗粒度审查见新增文档；既有工具、权限、协议和界面行为保持不变。该核验不扩展真实服务验收范围。
