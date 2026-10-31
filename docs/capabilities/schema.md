# 能力条目规范

每个 `entries/*.md` 以 YAML frontmatter 开头，必须恰好包含以下字段：

| 字段 | 说明 |
| --- | --- |
| name | 面向 Agent 的能力名称 |
| id | 稳定 ID，格式 `asterium.<小写名称>`，不可重复或复用旧 ID |
| appliesTo | 适用伙伴类型列表 |
| protocols | 支持协议列表；不适用填写 `internal` |
| permissionBoundary | 实际授权及可见范围说明 |
| status | `stable`、`experimental` 或 `deprecated` |
| codeEntries | 仓库相对路径列表 |
| tests | 仓库相对测试路径列表 |
| docs | 仓库相对文档路径列表 |
| lastVerifiedCommit | 已存在代码提交的完整 SHA |

正文说明适用场景、限制及验证范围。稳定不表示测试过所有外部服务或宿主。工具能力不等于授权；权限仍由运行时、工作区与群成员关系决定。新协议可以已完成模拟验证而尚待用户真实连接验收，必须明确写出。

校验器只读检查字段、ID、文件路径、提交存在及代码路径在该提交存在，不生成文档、不接触凭据、不运行模型。

## 建立发布基线之前

仅在尚未初始化 Git 的发布准备副本中，lastVerifiedCommit 暂记为 null。这不是合格的已核验条目；正式 check:capabilities 仍必须拒绝它，不放宽脚本。建立代码基线、核验代码与证据后，追加纯文档提交绑定已存在的基线 SHA。
