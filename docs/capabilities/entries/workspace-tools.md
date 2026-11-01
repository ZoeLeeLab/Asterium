---
{
  "name": "文件、命令与交付",
  "id": "asterium.workspace-tools",
  "appliesTo": [
    "api"
  ],
  "protocols": [
    "internal"
  ],
  "permissionBoundary": "文件限既有授权。默认/Full Native；可选 AppContainer+Job。普通审批仍走选定后端；非 Full 可单独申请仅本次 Native 命令审批，不变更设置或模式，不自动回退重放。",
  "status": "stable",
  "codeEntries": [
    "src/main/api/ApiAgentTools.ts",
    "src/main/execution/ExecutionGateway.ts",
    "src/main/execution/ExecutionPermissions.ts",
    "src/main/api/extensions/ExtensionLaunchBackend.ts",
    "src/main/security/PartnerWorkspaceStore.ts",
    "src/main/security/ArtifactRegistry.ts",
    "src/main/execution/ExecutionBackendRouter.ts",
    "src/main/execution/NativeCommandApproval.ts",
    "src/main/execution/SandboxExtensionLaunchBackend.ts",
    "src/main/execution/WindowsSandboxProcess.ts",
    "native/sandbox/WindowsSandboxHelper.cs",
    "src/main/security/ConversationAttachmentStore.ts",
    "src/main/studio/StudioAttachments.ts"
  ],
  "tests": [
    "tests/unit/apiAgentTools.test.ts",
    "tests/unit/commandExecution.test.ts",
    "tests/unit/executionPermissions.test.ts",
    "tests/unit/partnerWorkspaceStore.test.ts",
    "tests/unit/artifactRegistry.test.ts",
    "tests/unit/executionBackendRouter.test.ts",
    "tests/unit/sandboxCommand.test.ts",
    "tests/unit/sandboxProcessProtocol.test.ts",
    "tests/unit/nativeCommandApproval.test.ts",
    "tests/native-command-approval-smoke.mjs",
    "tests/unit/conversationAttachmentStore.test.ts",
    "tests/unit/studioAttachments.test.ts"
  ],
  "docs": [
    "docs/release-status.md",
    "docs/capabilities/schema.md",
    "docs/native-command-approval.md",
    "docs/studio-attachments.md"
  ],
  "lastVerifiedCommit": "a4a5ace1446b0a2601099cae337c21fbb56a8fb8"
}
---

文件、命令与交付的当前代码入口、测试和权限边界见以上元数据。

## 缩略图修复

src/main/security/attachmentThumbnail.ts 从主进程已解析授权的快照路径读取字节并生成有尺寸上限的缩略图；无扩展名快照不再交 Windows Shell 缓存。解码失败返回无缩略图，文件不存在/体积超限继续拒绝。MessageAttachmentCards.tsx 以会话与附件 ID 隔离卡片状态，缩略图失败不改写快照可用性，避免状态更新取消自身请求。附件读取、发送、会话及群聊授权沿用原存储校验，无数据迁移、无新命令权限。新增 unit/renderer 测试和 tests/attachment-thumbnail-electron-smoke.mjs 使用合成图片、独立临时目录，不读取用户连接或 Key；具体结果另记本轮收据。新代码提交存在后再绑定 lastVerifiedCommit，不以旧包或旧提交冒充本轮新基线。

Windows 沙箱为实验能力；Full 使用 Native，普通审批不授予沙箱外执行能力。

此前核验曾绑定已存在的本轮代码基线 `bff2507f7dfab0cfca4436e7b754b2557554d3de`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。

本轮仅修复 PowerShell 命令输出的 UTF-8 编码，使中文临时路径与子进程工作目录正确传回。原有中文路径断言保持，未扩大执行权限或变更 Codex 接入。


## 首版补齐阶段

附件存储新增群聊账本到当前 group:v3 原生会话的只读解析关联，Main 限制为该群已发布且处于输入序号边界内的附件 ID。未注册、其他群或单聊不能经该解析器读取；原生绑定释放只清理关联，不删除群聊快照。API 文本读取和原多模态能力继续复用现有实现。本项不新增命令权限、沙箱或认证体系；Full 原生命令沿用当前 Windows 账户授权语义。

当前 lastVerifiedCommit 绑定已存在代码提交 `a4a5ace1446b0a2601099cae337c21fbb56a8fb8`，之前的真实来源 `bff2507f7dfab0cfca4436e7b754b2557554d3de` 仍在历史中保留。全套检查及新包验收结果另见独立候选报告；不继承旧候选验收归属。
