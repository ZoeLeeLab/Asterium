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
    "src/renderer/components/settings/apiPartnerConnection.ts",
    "src/renderer/components/ui/PartnerQuickCard.tsx",
    "src/shared/apiPresets.ts",
    "src/main/api/listApiSiteModels.ts",
    "src/shared/apiConnections.ts",
    "src/main/agentIpc.ts"
  ],
  "tests": [
    "tests/unit/apiConnectionStore.test.ts",
    "tests/renderer/ApiConnectionsSettings.test.tsx",
    "tests/renderer/PartnerQuickCard.test.tsx",
    "tests/renderer/PartnerQuickSave.test.tsx",
    "tests/unit/apiSiteModels.test.ts",
    "tests/unit/desktopIpc.test.ts",
    "tests/api-providers-acceptance.mjs"
  ],
  "docs": [
    "docs/release-status.md",
    "docs/api-connections-guide.md"
  ],
  "lastVerifiedCommit": "a2c23abe4e2462e5a32660c56c875026f2164e45"
}
---

共享 API 连接与模型配置的当前代码入口、测试和权限边界见以上元数据。

真实模型、外部宿主及操作系统集成须以各自实际验收结果为准。

本条绑定本仓库首笔代码基线 `39122d3a15ba44f14568d6826b7dc5b590266cea`，已核对所列代码、测试和文档在该提交中存在。此绑定说明实现来源，不继承旧开发仓库、旧候选包或旧测试电脑的验收归属。

维护者已确认发布副本首次启动为空白。最终提交的完整自动检查、安装器构建及后续普通账户安装验收分别记录于独立候选报告；源码核验或模拟结果不代表真实 API、外部宿主或普通账户安装通过。

## 图片默认值修复

新建 API 模型及快速切换到新模型时，图片输入默认开启；已保存模型的明确开关值保持不变，旧 DeepSeek 适配器继续关闭图片。新增创建默认函数位于 src/shared/apiConnections.ts，两个入口为 apiPartnerConnection.ts 和 PartnerQuickCard.tsx；schema 对旧配置缺省字段仍保留原行为，不自动开启旧连接，不改凭据或用户资料。模拟 UI/存储/请求测试与真实服务验收区分记录。代码基线在提交存在后以纯文档核验绑定，不把开发版反馈当作新安装包验收。

本纯文档核验绑定已存在代码提交 `a2c23abe4e2462e5a32660c56c875026f2164e45`。代码/测试字节与此前通过 209 文件、1636 项全套测试和 95 项专项的工作区一致，实际打包结果另记新 r4 收据；未读取维护者 Key 或把用户开发版反馈写成安装包通过。其他协议、工具权限及凭据处理未改。
