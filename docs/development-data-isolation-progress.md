# 同机资料隔离：五阶段执行记录

2026-11-02，用户授权按以下顺序连续执行，每阶段测试通过、记录结果并单独本地提交；测试失败、范围扩大、可能触及日常真实数据或破坏性操作无法确认时立即停止。不 push、不安装、不发布，不覆盖现有 Beta，不修改原仓库及旧验收材料。

1. S1 启动隔离与最小并行验证。
2. S2 项目保存位置设置。
3. S3 候选验收启动器。
4. S4 自动测试目录与脚本迁移。
5. S5 综合核验与能力基线（纯文档核验提交，绑定此前已存在的代码提交）。

## S1 启动隔离与最小并行验证

来源：上一阶段已完成的工作区变更，父提交 `8e83edca3f8ce6f262a4eebff2dffa7ff92b55e8`。历史 S1 说明原样保留，当前用户授权取代其中“暂不提交”的停点。

本轮提交前重新核验：7 个相关测试文件、70 项通过；typecheck、lint、16 条能力检查及 diff check 均通过。真实 Electron 四环境同时运行、重复实例拒绝、junction 拒绝、日常／开发设置重启保留均通过；测试只用全新合成目录，成功退出后已清理。不代表完整安装包或真实服务验收。

代码与上述记录一并提交，提交信息包含 `S1 启动隔离`；本文件不引用自身未来提交号。能力新增文件的结构化入口及 lastVerifiedCommit 在 S5 纯文档核验时绑定已存在的真实代码提交。

S1 已完成本地提交：`ea6634abec534eedd07d65dec8853d4a4b30a315`，提交信息 `feat: S1 启动隔离与最小并行验证`。本机未设置 Git 作者身份，提交命令仅沿用最近项目提交的 Asterium Release 身份，未修改全局配置。

## S2 项目保存位置设置：门禁失败，立即停止

本阶段工作区已增加文件与存储设置、按环境保存的 defaultProjectRoot、目录有效性检查、旧项目路径保留及创建前最终路径确认，尚未提交。

本轮验证结果：5 个相关测试文件、23 项通过；typecheck 与 lint 通过。`npm run check:capabilities` 退出码 1，原始错误：`workspace-tools.md: Invalid YAML frontmatter`。

原因：S2 说明文字被错误插入 `docs/capabilities/entries/workspace-tools.md` 的 YAML 元数据区域。按用户“测试失败立即停止并汇报”的要求，不修正后继续、不提交 S2，不进入 S3。失败内容和 S2 工作区保留，等待用户后续指令。

当前 HEAD 保持 S1；S2 改动未暂存、未提交。S3 候选验收启动器、S4 测试迁移、S5 综合核验及能力基线均未开始。全程未 push、安装、发布或覆盖已有 Beta，未修改原仓库或旧验收材料。

## S2 格式修复与重新验收

用户明确授权保留 S1 和既有 S2 改动，仅修复 workspace-tools.md 的 YAML 格式后重验。已将原 S2 说明完整移到正文，元数据与 S1 提交中的能力定义逐字段一致；没有改动 S2 产品实现或测试。

重新执行同一组 5 文件／23 项测试全部通过；typecheck、lint、完整 16 条能力词典及 diff check 均通过。此前失败记录保留。S2 以独立提交 `feat: S2 项目保存位置设置` 归档，随后继续已确认的 S3；提交号由提交成功后的 Git 记录取得，不写入自身未来 SHA。

S2 已提交：`6e0e5a81057f940e603a96f3fdfbb97a0f41d14e`。继续 S3，保留 S1 和 S2 原提交，不回退或重做。

## S3 候选验收启动器：测试失败，立即停止

当前工作区新增系统 PowerShell 启动器、说明及合成候选 DryRun 测试，未运行真实候选或现有 Beta，未安装或创建日常资料。启动器要求明确独立解压 EXE、批次、端口，检查目录归属及链接，并生成候选哈希和参数回执。

首轮测试共 3 项，1 项通过、2 项失败。日常资料归属与 junction 拒绝检查通过；正常 DryRun 回执及标记为 acceptance 的目录复用检查失败。原始错误是系统 PowerShell 子进程无法识别 `Get-FileHash`（CommandNotFoundException）；未改写为通过，未自动修复或重跑。

typecheck、lint、完整 16 条能力检查均通过。依用户遇测试失败即停止的要求，S3 改动保持未暂存、未提交；HEAD 保持 S2，S4 和 S5 未开始。S1 不回退、不重做，原仓库、现有 Beta 和旧验收材料未改动。

## S3 同入口诊断、修复与重新验收

用户授权先按启动器相同入口只读诊断：系统 `WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -File`，相同继承环境和独立 LOCALAPPDATA 替身。版本为 5.1.26100.9711；Get-Command Get-FileHash 无结果，已加载 Utility 7.0.0.0 未导出该命令，但系统 Utility 3.1.0.0 仍可发现。

随后仅在该子进程中按绝对路径加载现有 `$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1`，命令恢复，来源版本 3.1.0.0。这确认是继承模块搜索路径导致的版本错配，不是系统缺少 SHA-256 能力，也不是路径引号或编码改变了候选内容。两轮原始诊断分别保存在 Git 忽略的 `.qa/s3-powershell-diagnosis-1793625339058/` 下，未覆盖首轮失败记录。

启动器改为先使用 .NET 设置本进程 UTF-8 编码，再显式加载当前 PSHOME 的现有 Utility 模块。未安装、升级 PowerShell，未修改系统模块、PSModulePath 或执行策略。原 Get-FileHash SHA-256 计算保留；模块加载和计算失败仍停止，未添加跳过哈希的分支。

S3 原有全部 3 项测试重新通过，包含中文和空格路径、Node crypto 对照候选哈希、目录归属及 junction 拒绝、DryRun 不启动／不写资料。typecheck、lint、完整 16 条能力及 diff check 全部通过。本阶段以 `feat: S3 候选验收启动器` 单独本地提交，随后进入 S4；尚无包含新代码的产品候选或真实人工安装验收。
