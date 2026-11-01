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
    "claude-cli",
    "deepseek-chat",
    "cyberboss-bridge"
  ],
  "permissionBoundary": "原生宿主权限和星丛授权并行生效；现有线程必须明确绑定，不代表支持任意中转站。 Claude CLI 候选存在 Full 原生命令绕过受保护路径检查的已复现阻断，尚不能宣称权限验收完整。",
  "status": "experimental",
  "codeEntries": [
    "src/main/adapters/CodexCliAdapter.ts",
    "src/main/adapters/ClaudeCodeAdapter.ts",
    "src/main/adapters/ExistingThreadAdapter.ts",
    "src/main/api/ApiProviderRegistry.ts",
    "src/main/adapters/ClaudeCliTransport.ts",
    "src/main/adapters/claudeStdioProxy.cjs",
    "native/claude-bridge/ClaudePipeHost.cs"
  ],
  "tests": [
    "tests/unit/codexCliAdapter.test.ts",
    "tests/unit/claudeCodeAdapter.test.ts",
    "tests/unit/existingThreadAdapter.test.ts",
    "tests/unit/apiProviderRegistry.test.ts",
    "tests/unit/claudeCliBootstrap.test.ts",
    "tests/unit/claudePlanRevision.test.ts",
    "tests/claude-cli-acceptance.mjs"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/claude-cli-compatibility.md",
    "docs/claude-cli-release-blocker.md"
  ],
  "lastVerifiedCommit": "bff2507f7dfab0cfca4436e7b754b2557554d3de"
}
---

伙伴接入的当前代码入口、测试和权限边界见以上元数据。

Claude 改为未修改官方 CLI，MCP 使用 stdio，经账户和当前 CLI 进程树绑定的本机 IPC 调用主进程业务与审批。原生工具显式 ask，路径检查与卡片归属为主，Hooks 仅为额外防线；无 SDK 回退或产品 HTTP 桥接。真实订阅仍待验收，版本支持以 Windows 合成服务实测报告为准，不推断更高版本。

本条核验绑定已存在代码提交 `bff2507f7dfab0cfca4436e7b754b2557554d3de`，不继承旧候选验收归属。构建和人工验收分别以新候选独立报告为准；模拟、源码及配置核验不代表真实服务或普通账户验收通过。

官方 CLI 合成回归还覆盖明确 session ID 恢复及部分流事件；不等于真实订阅已验收。

发布阻断：官方 2.1.316 与合成文件已复现 Full 原生命令的编码路径绕过，见阻断记录。常规传输通过不等于完整权限验证；未构建候选，不重新绑定为已通过代码基线。
