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
    "src/main/adapters/ClaudeCliTransport.ts"
  ],
  "tests": [
    "tests/unit/partnerMemoryToolService.test.ts",
    "tests/unit/partnerMemoryService.test.ts",
    "tests/unit/diaryGenerators.test.ts",
    "tests/unit/partnerDiaryScheduler.test.ts",
    "tests/unit/nativeProfileReload.test.ts",
    "tests/unit/nativeSessionCompaction.test.ts"
  ],
  "docs": [
    "docs/capabilities/schema.md",
    "docs/claude-cli-compatibility.md",
    "docs/data-isolation.md"
  ],
  "lastVerifiedCommit": "10437a8d41a665073d7c091ce2dc31ad805ba0ad"
}
---

伙伴记忆的当前代码入口、测试和权限边界见以上元数据。

## 旧对话文本导入（当前工作区）

设置中的记忆管理支持粘贴文本和 UTF-8 `.txt`、`.md`，单次最多 10 万字符。手动确认发送后，「记忆管理 API 配置」所选模型只接收选定文本，使用空工具列表。伙伴无需开启自动兜底。提炼结果在用户勾选并确认后，按伙伴批量写入档案。来源保留标签、段落编号和短摘录，批次回执可防止重复提交。结果页可以撤销本批未修改、未被引用的条目。旧来源继续可读。预览区分模型未找到长期信息和已有重复项。模型可在原模型框内选择或手填。导入跳过可识别的内部自动化触发记录，模型整批输出无法读取时重试一次，仍失败则继续处理后续片段。条目逐条校验，预览保留有效候选，并标明跳过条目和失败片段数。DeepSeek 官方基础地址可直接填写，内部规范化为请求端点。

本功能以合成模型输出和界面测试核验，实际服务联调待指定测试连接。当前工作区入口为 `src/main/memory/MemoryImportService.ts` 和 `src/renderer/components/memory/MemoryImportPanel.tsx`，测试为 `tests/unit/memoryImportService.test.ts` 和 `tests/renderer/MemoryImportPanel.test.tsx`。历史核验提交号保持原归属。

记忆业务权限不变，Claude 调用改经官方 CLI；日记生成继续禁用工具并不保存原生会话。已有记忆导入能力仍在确认，尚未提供通用导入，不自动继承外部历史。日记、重读与压缩的合成回归不等于真实订阅通过。

本条核验绑定已存在代码提交 `10437a8d41a665073d7c091ce2dc31ad805ba0ad`，不继承旧候选验收归属。构建和人工验收分别以新候选独立报告为准；模拟、源码及配置核验不代表真实服务或普通账户验收通过。
