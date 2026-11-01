# 开发、检查与验收流程

本说明区分开发机自动检查、候选构建与测试电脑人工验收。它是操作流程，不是已通过的验收结果；对应版本的实际结果见 [Release Notes](releases/0.1.0-candidate-20261031-r1.md)。

## 开发环境与首次运行

- Windows x64、Node.js 24.x、npm。
- Windows PowerShell，以及系统中的 `Microsoft.NET/Framework64/v4.0.30319/csc.exe`。脚本通过 `SystemRoot` 定位编译器，启动和打包时会编译 Windows helper。
- 可访问 npm、Electron 下载源和锁文件中 SheetJS 的官方下载地址；保持 TLS 校验。
- 使用专用开发账户或明确隔离的数据，避免开发实例复用私人资料。方法见 [数据目录与隔离验收](data-isolation.md)。

在项目根目录运行：

```powershell
npm ci
npm start
```

Node.js 开发环境与 Electron 内嵌的 Node.js 是两个环境。项目没有必须复制的 `.env.example`，连接凭据通过应用正式界面配置。执行这两个命令的说明不等于声明已在所有新环境验证过依赖安装；实际验证范围以版本记录为准。

## 源码与离线检查

以下命令只在开发机的目标源码仓库中执行。为临时目录、缓存和产物预留空间，并记录实际配置；这些内容应保持在 Git 忽略范围内。

```powershell
npm run typecheck
npm run lint
npm run check:capabilities
npm ls --all
npm test -- --pool=threads --maxWorkers=1 --testTimeout=30000 --teardownTimeout=30000
npm run test:empty-start
npm run build:renderer
npm run sandbox:build
npm run build:studio-wake
npm run test:studio-wake-adapter
npm run build:automation-adapter
npm run test:automation-adapter
```

`test:empty-start` 需要 Edge，或通过 `ASTERIUM_BROWSER_EXE` 指定浏览器。单元与 Renderer 测试使用合成夹具，两个 Adapter 脚本默认使用 mock，不需要私人模型凭据。单 worker 和测试时限是运行参数，不可通过跳过失败断言、伪造旧记录或放宽能力词典检查换取通过。

保留各命令退出码、完整测试报告和失败尝试，确认全部测试文件有报告，分别列出失败、跳过和 TODO。检查源码隐私、凭据、忽略规则、文档链接和待上传文件清单。新增或修改能力时同步维护能力记录；文档重组且能力范围未变时，可记录无需修改条目的理由。

## 构建应用与安装器

获得构建授权并确认必要检查通过后，在目标源码根目录执行：

```powershell
npm run package
```

Forge 会编译主进程、Preload、Renderer 和 Windows helper，输出到 `out/`。仓库默认没有设置安装器 maker 或签名，此命令只生成应用目录。

既有候选安装器由单独冻结的构建配方生成。配方、工具版本及锁文件、来源提交、候选哈希和检查日志分别保存，目前配方未纳入本仓库。不能只凭 `npm run package` 声称可重建字节相同的既有安装器；工具版本和候选事实见 Release Notes。

新构建应导出并核对已存在的源码提交，记录构建配方的产物处理、平台与架构，核对 x64 应用和 helper。解包安装器，将应用文件与已审计的应用目录比对，检查是否混入私人路径、账号、凭据、测试资料、日志、缓存、源码映射或开发产物。第三方代码扫描命中需逐项复核，保留原命中与结论，不能只删掉记录。

## 新应用的四组隔离桌面检查

在源码根目录将下列路径指向本次新应用；示例是 Forge 的默认输出。使用外部候选时填入其实际路径，不用旧包代替：

```powershell
$env:ASTERIUM_PACKAGED_EXE = (Resolve-Path -LiteralPath '.\out\Asterium-win32-x64\Asterium.exe').Path
$env:ASTERIUM_API_LIVE_SMOKE = '0'
$env:ASTERIUM_CLAUDE_LIVE_SMOKE = '0'
$env:ASTERIUM_CODEX_LIVE_SMOKE = '0'
npm run test:startup
npm run test:memory-sqlite
npm run test:extensions
npm run test:api-providers
```

这些指定脚本使用隔离数据；扩展检查默认离线，四协议检查使用本地模拟服务。它们可以检查打包后的加载、存储与合同范围，不证明真实 API、CLI 登录或外部宿主已联调。脚本输出与临时夹具不能再混入安装包。

不要遍历运行所有 smoke 或带 `live` 的脚本。真实连接需由用户指定并单独授权；不读取私人凭据，不把 Key 放入源码或聊天。

## 测试电脑人工验收

测试电脑不需要 Git、npm 或开发环境。只使用绑定明确来源和哈希的固定候选、配套说明与必要的已冻结工具，通过正式界面操作。失败时回传原始证据，由开发机修复；不在测试机改脚本或哈希放行。

按顺序记录每项的操作、预期、实际与证据。下表是待执行模板，不代表每项已通过：

| 阶段 | 操作与核对 |
| --- | --- |
| 候选身份 | 核对安装器文件名、大小及 SHA-256，与版本清单一致。 |
| 当前用户安装 | 在标准 Windows 账户下安装到新目录，核对提权提示、目录与对应版本的快捷方式、完成页行为。 |
| 空白与隔离 | 用新账户或新数据目录启动，无预置伙伴、聊天、项目或凭据；保留原账户资料。 |
| 窗口与导航 | 最小化、最大化、还原和调整窗口大小；切换主要页面，无白屏、卡死或关键按钮遮挡。 |
| 设置与生命周期 | 修改外观并彻底退出后重启；测试托盘恢复与明确退出，检查设置持久化。 |
| 项目与文件 | 用通用名称建立新项目和群聊，在新的测试文件夹核对基础文档与交付区；重启后核对项目和文件。 |
| 记忆管理 | 为专用测试伙伴核对查看、检索、新增、编辑、评论、回收站恢复及永久删除；记录实际启用的记忆模式，不把外部历史视作已导入。 |
| 权限与协作 | 在专用目录按指定模式核对审批、拒绝和取消；由已授权的测试伙伴进行分工、回复与结果复核。 |
| 真实服务 | 经用户指定后分别测试 API、CLI 与外部宿主，逐项记录来源与结果，不能从 mock 结果推断成功。 |
| 卸载与重装 | 功能检查后，在专用验收环境核对卸载项目、新安装与数据保留，不清空原账户或私人项目。 |

没有连接时，可以先完成空白界面、窗口、设置与项目等离线部分；需要伙伴、模型或外部宿主的步骤另行安排。自动化的详细真实验收见 [自动化说明](automations-user-guide.md)，其他入口见 [API 连接](api-connections-guide.md)、[MCP 与 Skills](api-extensions-guide.md)、[命令审批](native-command-approval.md)。

## 记录与归属

实际结果写入对应版本 Release Notes，原始回传和日志分别保留。候选源码提交、脚本更新、安装器更新及人工反馈分别归属，不覆盖旧包、旧哈希或原始证据，也不把未执行的步骤记为通过。

提交、上传、签名和发布是分别授权的动作；整理文档或执行检查不代表已经获准执行这些动作。
