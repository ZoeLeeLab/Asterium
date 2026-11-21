---
{
  "name": "伙伴记忆",
  "id": "asterium.memory",
  "appliesTo": [
    "api",
    "local_cli"
  ],
  "protocols": [
    "internal"
  ],
  "permissionBoundary": "记忆按伙伴隔离，工作区权限不自动授予记忆访问；规划会话等场景有额外限制。",
  "status": "stable",
  "codeEntries": [
    "src/main/memory/PartnerMemoryToolService.ts",
    "src/main/memory/PartnerMemoryService.ts",
    "src/main/diary/DiaryGenerators.ts",
    "src/main/adapters/ClaudeCliTransport.ts",
    "src/shared/memoryFallback.ts",
    "src/main/memory/fallback/MemoryFallbackSettingsStore.ts",
    "src/main/memory/fallback/MemoryFallbackScheduler.ts",
    "src/main/memory/fallback/MemoryConsolidation.ts",
    "src/renderer/components/memory/MemoryFallbackSettings.tsx",
    "src/main/memory/MemoryImportService.ts",
    "src/shared/memoryImport.ts",
    "src/renderer/components/memory/MemoryImportPanel.tsx"
  ],
  "tests": [
    "tests/unit/partnerMemoryToolService.test.ts",
    "tests/unit/partnerMemoryService.test.ts",
    "tests/unit/diaryGenerators.test.ts",
    "tests/unit/partnerDiaryScheduler.test.ts",
    "tests/unit/nativeProfileReload.test.ts",
    "tests/unit/nativeSessionCompaction.test.ts",
    "tests/unit/memoryFallbackSettings.test.ts",
    "tests/unit/memoryFallbackScheduler.test.ts",
    "tests/unit/memoryConsolidation.test.ts",
    "tests/renderer/MemoryFallbackSettings.test.tsx",
    "tests/unit/memoryImportService.test.ts",
    "tests/renderer/MemoryImportPanel.test.tsx"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/claude-cli-compatibility.md",
    "docs/data-isolation.md",
    "docs/api-connections-guide.md",
    "docs/avatar-memory-fallback-2026-11-02.md"
  ],
  "lastVerifiedCommit": "8bbec45d55d93ce0d1a7adc754f6447fba414fcc"
}
---

伙伴记忆的当前代码入口、测试和权限边界见以上元数据。

当前 Bug 工作分支补齐旧对话导入的主题标签。提炼提示要求模型提供标签，候选预览显示标签，确认后规范化去重并保存。旧候选未带标签时仍可确认。实现位于 `MemoryImportService.ts`、`memoryImport.ts` 和 `MemoryImportPanel.tsx`，回归见 `memoryImportService.test.ts`、`MemoryImportPanel.test.tsx`。本次核验引用已存在提交 `8bbec45d55d93ce0d1a7adc754f6447fba414fcc`。116 项针对性回归、类型、lint、隐私与能力检查通过，独立 Chromium 检查通过；安装包与真实模型验收另行执行。

在「设置 → 记忆」中，内容超出窗口时可在内容区上下滚动，滚动条隐藏。展开的设置、导入区和记忆档案可以一起滚动。

## 旧对话文本导入（当前工作区）

设置中的记忆管理支持粘贴文本和 UTF-8 `.txt`、`.md`，单次最多 10 万字符。手动确认发送后，「记忆管理 API 配置」所选模型只接收选定文本，使用空工具列表。伙伴无需开启自动兜底。提炼结果在用户勾选并确认后，按伙伴批量写入档案。来源保留标签、段落编号和短摘录，批次回执可防止重复提交。结果页可以撤销本批未修改、未被引用的条目。旧来源继续可读。预览区分模型未找到长期信息和已有重复项。模型可在原模型框内选择或手填。导入跳过可识别的内部自动化触发记录，模型整批输出无法读取时重试一次，仍失败则继续处理后续片段。条目逐条校验，预览保留有效候选，并标明跳过条目和失败片段数。DeepSeek 官方基础地址可直接填写，内部规范化为请求端点。

本功能以合成模型输出和界面测试核验，实际服务联调待指定测试连接。当前工作区入口为 `src/main/memory/MemoryImportService.ts` 和 `src/renderer/components/memory/MemoryImportPanel.tsx`，测试为 `tests/unit/memoryImportService.test.ts` 和 `tests/renderer/MemoryImportPanel.test.tsx`。历史核验提交号保持原归属。

## 按伙伴导出与恢复

在「设置 → 记忆」选中一个由星丛托管记忆的伙伴，点击记忆档案旁的「导出记忆」。本地压缩备份包含记忆正文、权重、标签、补充记录、来源锚点及已保存的来源摘要，也保留归档状态。备份只含记忆资料。

换电脑后选中目标伙伴，在「导入旧对话」里点「导入星丛记忆」，选择备份文件，核对目标伙伴和条数后确认。恢复在本机进行，无需配置模型。已存在的记忆 ID 会跳过，其余记忆在一次数据库事务中写入。旧聊天未迁移时，可查看备份中已有的来源摘要，原聊天链接需要对应聊天记录。

记忆档案和归档库显示所选伙伴符合当前搜索及筛选条件的全部记录。在「记忆档案」进入「批量删除」后，可用列表左上方的「全选」复选框勾选或清空当前结果，也可单独调整勾选。确认后，选中的记忆会移入归档库，可在归档库恢复。

归档库背景取当前主题的页面底色并略微压深，随浅色和深色模式切换。可单独勾选或全选当前筛选结果，再确认永久删除。批量永久删除在同一事务中校验归档状态、更新版本和替代引用，校验失败时整批保留。

## 独立记忆兜底的多协议配置

当前工作区的兜底可选择 DeepSeek 官方及四种现有通用协议，保留独立凭据、逐伙伴开关、历史范围和整理权限；新地址不会自动继承旧服务 Key。请求仍只提供本伙伴的检索、证据读取和受校验的整理提案，不启用普通伙伴的 MCP、命令或子代理工具。协议接入目前以合成模型响应验证，具体服务及模型尚待用户指定测试连接验收。

结构化核验 SHA 保留历史基线。记忆 API 的配置和验证范围见阶段记录与 API 配置文档。

记忆业务权限不变，Claude 调用改经官方 CLI；日记生成继续禁用工具并不保存原生会话。旧对话可经手动预览导入星丛记忆。日记、重读与压缩的合成回归不等于真实订阅通过。

本条核验绑定已存在代码提交 `10437a8d41a665073d7c091ce2dc31ad805ba0ad`，不继承旧候选验收归属。构建和人工验收分别以新候选独立报告为准；模拟、源码及配置核验不代表真实服务或普通账户验收通过。
