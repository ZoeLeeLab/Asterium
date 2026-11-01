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
  "permissionBoundary": "原生宿主权限与星丛审批并行生效；手动命令等待允许，Full 授权当前 Windows 账户权限，不提供任意原生命令的操作系统级文件隔离。只读、取消、会话归属和一次性审批仍校验。现有线程须明确绑定。",
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
  "lastVerifiedCommit": "2b084045c0f923bba54127d0cb3366a730df55f5"
}
---

伙伴接入的当前代码入口、测试和权限边界见以上元数据。

Claude 改为未修改官方 CLI，MCP 使用 stdio，经账户和当前 CLI 进程树绑定的本机 IPC 调用主进程业务与审批。原生工具显式 ask，路径检查与卡片归属为主，Hooks 仅为额外防线；无 SDK 回退或产品 HTTP 桥接。真实订阅仍待验收，版本支持以 Windows 合成服务实测报告为准，不推断更高版本。

本条核验绑定已存在代码提交 `2b084045c0f923bba54127d0cb3366a730df55f5`，不继承旧候选验收归属。构建和人工验收分别以新候选独立报告为准；模拟、源码及配置核验不代表真实服务或普通账户验收通过。

官方 CLI 合成回归还覆盖明确 session ID 恢复及部分流事件；不等于真实订阅已验收。

维护者已明确 Full 的原生账户权限。前次编码路径观察及失败报告作为历史保留，当前验收按手动允许／拒绝、Full 放行、只读拒绝及桥接归属执行；不新增 Claude 沙箱。

CLI 子进程单独关闭后台自更新，不更改用户全局设置，仍由用户维护官方版本；真实订阅验收独立记录。
