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
    "src/main/studio/StudioMcpHost.ts",
    "src/main/studio/StudioMcpAccessStore.ts",
    "src/main/agentIpc.ts",
    "src/renderer/components/settings/StudioMcpSettings.tsx"
  ],
  "tests": [
    "tests/unit/studioMcp.test.ts",
    "tests/renderer/StudioMcpSettings.test.tsx",
    "tests/unit/studioExternalRoom.test.ts",
    "tests/unit/runtimeEnvironment.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/studio-attachments.md",
    "docs/data-isolation.md",
    "docs/development-data-isolation-s1.md",
    "docs/automatic-test-isolation.md",
    "docs/development-data-isolation-progress.md",
    "docs/development-data-isolation-s5.md"
  ],
  "lastVerifiedCommit": "a8c1a7838c732fa834d23cc463dff39d393f44cb"
}
---

## 当前源码核验：2026-11-02 S5

本条绑定已存在的代码提交 `89a6c2dfd803b470690f1a2993d8ba729e981dca`；本次为纯文档核验，不使用自身或未来提交号。新资料的 MCP 默认端口按环境区分，自动测试允许端口 0 并在状态中返回实际监听端口；已有配置保留，端口冲突明确失败。非日常启动默认不恢复监听，明确开启后台恢复或手动配置仍沿用既有权限。伙伴凭据、成员资格及撤销边界未放宽。

本轮最终完整离线回归为 213 文件／1672 通过／2 既有 TODO；另有真实 Electron 窄范围并行、renderer-only 及 mock 合同检查。没有新产品候选、安装升级、真实 API／CLI 会员服务或外部宿主人工验收。详见 [S5 审计](../../development-data-isolation-s5.md)。

## 凭据复制

在 MCP 管理页生成接入凭据后，可以复制到系统剪贴板。写入完成后才显示「已复制」，失败后可用同一份凭据重试。隐藏或离开页面后，这次生成的凭据无法再次复制。自动测试使用合成凭据覆盖复制完成、失败重试及隐藏。

## 历史阶段记录

外部伙伴群聊 MCP的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

首次核验曾绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。


## 首版补齐阶段

公开历史 DTO 新增可选附件元数据，只白名单输出 id、name、mediaType、sizeBytes；即使内部账本额外带有字段，也不输出源路径或文件内容。没有新增附件传输工具，外部伙伴仍须另行共享文件。自动测试验证元数据与路径排除，原有凭据、成员代次、撤销和历史回执边界不变；不表示真实外部宿主接入完成。

当前 lastVerifiedCommit 绑定已存在代码提交 `a4a5ace1446b0a2601099cae337c21fbb56a8fb8`，之前的真实来源 `39122d3a15ba44f14568d6826b7dc5b590266cea` 仍在历史中保留。全套检查及新包验收结果另见独立候选报告；不继承旧候选验收归属。

## 2026-11-02 S1 未提交源码增量

本轮源码按启动环境选择新资料的 MCP 默认端口：日常 17361、开发 17362、验收显式指定、自动测试允许 0 并返回系统实际分配端口。已有配置保留，冲突明确失败。非日常默认不恢复监听，手动配置仍沿用既有权限；后台恢复须在启动时显式开启。

lastVerifiedCommit 保留原已提交基线，不代表本轮未提交实现已绑定。仅完成启动隔离与最小并行核验，不继承旧候选验收；结果与后续停点见 [S1 记录](../../development-data-isolation-s1.md)。
