# 命令与 Native 审批

API 伙伴的命令、Skill 脚本与 MCP stdio 通过统一执行入口运行。权限模式、工作区授权、Plan/只读以及取消规则共同生效。

- 沙箱默认关闭。开启且非 Full 时，本地命令、Skill 和 MCP stdio 使用 Windows AppContainer 与 Job；联网开关仅影响本地沙箱进程。
- Full 使用 Native。普通审批或持续信任不授予越出沙箱的许可。
- 非 Full 的 run_command 可带 require_escalated 与非空理由请求仅本次 Native 审批，票据绑定精确命令、目录、身份、权限和工作区代次；不提权，不改变持续信任或全局设置。
- 失败不自动回退 Native，不自动重放。可能产生副作用的操作不能以重试名义绕过审批。
- Skill/MCP 不新增同类 Native 出口。HTTP MCP、模型连接和网页工具保持各自网络与权限规则，不能隔离远端服务内部行为。

当前为实验执行边界。本文描述代码设计，不代表本发布副本的新候选已经通过桌面或安全验收。
