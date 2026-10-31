---
name: workspace-report
description: 创建当前工作区顶层文件清单，输出一份 Markdown 报告。
---

先读取 references/format.md。需要报告时，通过本 Skill 的 skill_run 工具执行 scripts/report.mjs，参数为一个新报告文件名，例如 ["workspace-report.md"]。

脚本只读取当前工作区顶层条目，并用独占创建方式保存报告。不要用 run_command 替代脚本审批。如果报告已存在，请征求用户意见后换一个文件名。执行完成后，用 deliver_file 登记返回的准确绝对路径，供用户预览。
