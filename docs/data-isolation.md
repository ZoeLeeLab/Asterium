# 数据目录与隔离验收

本说明用于保留已有星丛资料，并在独立数据目录或专用 Windows 账户中验收 Beta。当前记录见 [Beta Release Notes](releases/0.1.0-beta.1-r1.md)；旧候选的行为仍以其原记录为准。

## 2026-11-02 源码阶段 S1：启动隔离

本节是尚未提交、尚未打包的源码变更，不改变已公开 beta.1 的行为。用户明确要求先完成启动隔离和最小并行验证，再停下汇报；项目默认位置设置页、专用验收启动器及全套自动测试脚本迁移留到下一阶段。

| 环境 | 选择方式 | 资料默认位置 | 项目默认位置 |
| --- | --- | --- | --- |
| 日常 | 安装版默认，或显式 `--asterium-profile=daily` | `%APPDATA%/Asterium-Beta` | 文档 / Asterium Projects |
| 开发 | 源码 `npm start` 默认 | `%LOCALAPPDATA%/Asterium-Dev` | 当前资料 / Projects |
| 人工验收 | `--asterium-profile=acceptance --asterium-acceptance-batch=r1 --asterium-mcp-port=17363` | `%LOCALAPPDATA%/Asterium-Test/r1` | 当前资料 / Projects |
| 自动测试 | `--asterium-profile=autotest --user-data-dir=<绝对路径>` | 必须位于本次系统临时目录的 `Asterium-AutoTest/<运行>/<worker>/…` | 当前资料 / Projects |

`--user-data-dir` 继续有效。非日常目录必须是全新空目录或具有同类 `.asterium-profile.v1.json` 标记的目录；不认领无标记的已有资料。旧日常目录无需迁移，首次启动只添加归属标记。不同环境不得复用目录或嵌套在其他环境的已标记目录中。

启动在业务存储服务创建前检查真实规范化路径，识别 Windows 短路径、大小写及目录 junction／符号链接。非日常资料路径存在链接时拒绝启动，也检查内部临时、日志、崩溃和默认项目目录的链接；不通过链接访问日常资料。已识别的日常默认目录及其祖先／子目录同样拒绝用于非日常环境。错误不回退、不清空、不自动换目录。

Electron 用户资料、浏览器 sessionData、日志、崩溃记录及本进程树 TEMP/TMP 跟随当前环境。开发／验收窗口和托盘有明确标记。不同资料目录可并行，同一资料目录仍由 Electron 单实例锁保护。

只有日常安装版注册自启动和执行安装更新，非日常启动不自动检查更新。不自动恢复群聊 MCP、Wake、自动化、日记和记忆兜底调度；显式追加无值开关 `--asterium-background-services` 可在本次启动中启用恢复。手动开启 MCP／Wake 保留原有权限；MCP 新资料默认端口日常 17361、开发 17362，验收要求明确端口，自动测试允许 0，由操作系统分配并在状态中返回实际端口。已有 MCP 配置保留，端口冲突明确报错，不重试其他实例。

本地 CLI 的官方登录、原生线程与记忆不在此隔离范围。单项目选址能力继续保留，但“自定义默认项目位置”的设置页尚未实施。

开发机运行 `npm run test:profile-isolation` 可执行窄范围真实 Electron 检查：独立四环境、同目录重复实例、junction 拒绝及日常／开发设置重启保存。每次使用新建的 `%TEMP%/Asterium-AutoTest/<本次运行>/worker-0`；停止所有测试进程后才检查归属及链接并清理，失败留存。这不是正式安装包界面验收，也不表示其他自动测试已迁移。

旧自动化脚本尚未统一接入新 profile 和目录分配器，当前不以遍历旧 smoke 代替 S1 验证。阶段记录见 [S1 核验说明](development-data-isolation-s1.md)。

## 数据边界

## S2 源码：自定义默认项目保存位置

通用设置新增“文件与存储”：只读查看应用资料目录，选择、打开或恢复当前环境的默认项目位置。日常、开发、验收各自保存选择；不设置时沿用该环境默认值。单项目仍可另选文件夹。

选择的自定义位置必须已经存在且当前可读写，保存时规范化为真实路径；保存失败保留原值。新建项目时再次验证自定义位置，不因位置失效退回其他目录。默认位置改变只影响未来项目，已有项目不移动，恢复默认不删除文件。创建前通过原生确认窗口显示最终完整项目路径；取消不创建项目或消耗所选目录。

S2 尚未进入现有公开 Beta；验收结果见 [五阶段记录](development-data-isolation-progress.md)。

## S3 源码：候选验收入口

新增 `tools/acceptance/Start-AsteriumAcceptance.ps1`，测试电脑通过系统 PowerShell 指定独立解压候选、批次和端口；`-DryRun` 只返回候选 SHA-256、资料位置和完整启动参数，不启动程序或创建资料目录。具体命令、单次操作及退出边界见 [启动器说明](../tools/acceptance/README.md)。仅适用于包含新 profile 的后续候选，不将已公开 beta.1 当作新功能候选。

## S4 源码：自动测试运行目录

Vitest 和 35 个独立 Node 检查入口已接入运行／worker／用例目录分配、进程局部 TEMP/TMP、托管资源关闭及受限清理。失败保留、显式清理和真实测试来源的要求见 [自动测试隔离](automatic-test-isolation.md)。阶段验收及提交仍以 [执行记录](development-data-isolation-progress.md) 为准；不把未执行的新包检查或真实服务联调写作通过。

应用设置、聊天状态、连接配置与受管伙伴资料保存在当前 Windows 用户的 Electron `userData` 目录，伙伴资料位于其中的 `AsteriumData` 子目录。API Key 通过系统加密机制保存在该用户数据目录，不写入源码或 `.env`。

项目文件与应用资料分别保存。已公开 Beta 的默认项目根是当前用户的“文档 / Asterium Projects”，也可以由用户另选文件夹。本地 CLI 的登录、原生线程与记忆由对应宿主管理。新源码的各环境默认位置见上表。

Beta 直接双击默认使用 `%APPDATA%/Asterium-Beta`，固定安装标识为 `Asterium.Beta`，默认程序文件夹为当前用户 Programs 下的 `Asterium Beta`，不自动迁移旧版默认资料，也不使用旧版默认程序文件夹。后续 Beta 沿用该身份与资料目录；同一账户已运行 Beta 时会看到此前的 Beta 资料。仅改变安装目录不能再次隔离资料。指定 `userData` 也不会自动隔离项目文件夹、CLI 登录资料或远程服务。

接入伙伴不等于导入其已有记忆。当前可管理星丛内按伙伴存储的记忆记录；已有记忆导入能力仍在确认，尚未提供通用导入功能，不自动继承外部聊天历史或原生宿主记忆。

## 普通账户准备

以下安装器及旧显式数据目录步骤对应已公开 beta.1。新源码 profile 不追溯到旧安装器；后续包含 S1 的候选应使用上面的显式验收环境。

使用专用 Windows 标准账户，并确认该账户是否曾运行过星丛。管理员账户中不提权启动应用，不能替代标准账户验收。

在测试账户内核对安装包哈希，安装到新的目录。使用该账户的新项目文件夹，不导入原账户资料、不选择私人工作目录。测试电脑只运行固定候选并通过正式界面操作，不需要 Git、npm 或开发环境，也不在测试机修改代码、脚本或哈希。

## 首次指定新数据目录

先彻底退出已有星丛实例；若窗口关闭后仍在托盘，使用托盘菜单退出。打开新安装目录，确认其中有 `Asterium.exe`，在资源管理器地址栏输入 `powershell`。

下面每个代码框都是一整行。首次命令在当前账户下使用一个独立目录；同名目录已存在时停止，不清空、不复用：

```powershell
& { $data = Join-Path $env:LOCALAPPDATA 'Asterium-Acceptance-01'; if (Test-Path -LiteralPath $data) { throw 'Acceptance data directory already exists. Choose a new name.' }; & '.\Asterium.exe' "--user-data-dir=$data" }
```

如果目录已存在，先核实它的用途。需要新一轮验收时，换一个新目录名，并在该轮后续启动中保持同名；不要通过删除原目录来让检查通过。

首次界面应没有预置伙伴、聊天、项目、角色或凭据。应用会创建自身必要的设置和缓存文件，“空白工作台”不表示磁盘目录必须没有任何文件。

## 重启与保存检查

修改一个明显的外观设置，彻底退出后，在同一安装目录执行：

```powershell
& { $data = Join-Path $env:LOCALAPPDATA 'Asterium-Acceptance-01'; if (-not (Test-Path -LiteralPath $data -PathType Container)) { throw 'Acceptance data directory not found.' }; & '.\Asterium.exe' "--user-data-dir=$data" }
```

检查设置是否保留。后续验收持续使用相同账户、候选和启动方式；带参数启动与直接双击可能读到不同资料，不能交替使用后将差异记为数据丢失。

## 保留与回传

记录安装包哈希、操作步骤、启动方式、结果、截图和原始报错。截图与回传前移除真实名字、账号、聊天、Key、项目内容和个人路径；不要改写原错误来隐藏失败。

Beta 卸载配置保留应用资料，仍需普通账户实际验证。先在专用 Beta 目录中创建通用测试伙伴和外观设置，退出、卸载后核实资料仍在，再重装核实设置与伙伴保留；旧版资料和其他安装不得变化。首次测试快捷方式默认勾选，再取消安装、卸载重装，检查选择保留；完成页“立即打开星丛”应默认不勾选，仅勾选后启动。本轮只操作专用测试目录，不提供通用清空或递归删除命令。更多步骤见 [开发、检查与验收流程](development-and-validation.md)。
