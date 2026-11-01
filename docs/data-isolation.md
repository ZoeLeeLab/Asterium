# 数据目录与隔离验收

本说明用于保留已有星丛资料，并在独立数据目录或专用 Windows 账户中验收 Beta。当前记录见 [Beta Release Notes](releases/0.1.0-beta.1-r1.md)；旧候选的行为仍以其原记录为准。

## 数据边界

应用设置、聊天状态、连接配置与受管伙伴资料保存在当前 Windows 用户的 Electron `userData` 目录，伙伴资料位于其中的 `AsteriumData` 子目录。API Key 通过系统加密机制保存在该用户数据目录，不写入源码或 `.env`。

项目文件与应用资料分别保存。默认项目根是当前用户的“文档 / Asterium Projects”，也可以由用户另选文件夹。本地 CLI 的登录、原生线程与记忆由对应宿主管理。

Beta 直接双击默认使用 `%APPDATA%/Asterium-Beta`，固定安装标识为 `Asterium.Beta`，不自动迁移旧版默认资料。后续 Beta 沿用该目录；同一账户已运行 Beta 时会看到此前的 Beta 资料。仅改变安装目录不能再次隔离资料。指定 `userData` 也不会自动隔离项目文件夹、CLI 登录资料或远程服务。

接入伙伴不等于导入其已有记忆。当前可管理星丛内按伙伴存储的记忆记录；已有记忆导入能力仍在确认，尚未提供通用导入功能，不自动继承外部聊天历史或原生宿主记忆。

## 普通账户准备

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
