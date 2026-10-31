# 星丛 Asterium

面向个人与小团队的多 AI 桌面工作台，支持本地 CLI、API 伙伴、单聊、工作室、项目协作、伙伴资料、记忆及自动化。

当前版本为开发版本，源码已经过发布隐私整理。代码核验来源以能力条目和实际 Git 历史为准；安装器及验收状态以绑定具体提交的独立构建报告为准。旧开发仓库的验收结果不代表本仓库的新候选已验收。见 [发布状态](docs/release-status.md) 和 [能力索引](docs/capabilities/index.md)。

## 环境

- Windows x64。当前启动和打包流程会编译 Windows helper，暂不提供 macOS/Linux 支持声明。
- Node.js 24.x；本次使用 Node 24.18.0、npm 11.16.0。Node 与 Electron 内嵌的 Node 是两个不同运行环境。
- 系统需提供 Windows PowerShell，以及 Microsoft.NET/Framework64/v4.0.30319/csc.exe。helper 编译脚本使用 SystemRoot 定位它；缺失时应先解决环境，不绕过编译检查。
- 安装依赖时需要访问 npm、Electron 下载源及锁文件中 SheetJS 的官方下载地址。不要关闭 TLS 校验。
- 本地 Codex/Claude 伙伴需要另行安装相应 CLI、完成用户自己的登录并在界面选择运行环境。API 伙伴需配置自己的服务、模型与 Key；并非启动应用的必需条件。

## 安装和开发

在项目根目录的 PowerShell 中运行：

```powershell
npm ci
npm start
```

start 会先编译沙箱 helper，再启动 Electron Forge/Vite。首次打开是空白工作台，没有预置伙伴、聊天、项目、角色或示例凭据。请在伙伴管理页添加自己的连接；不导入旧开发机个人目录。

API Key 通过正式设置界面保存到系统加密存储，不写入源码或 .env。本项目没有必须复制的 .env.example。不要把自己的认证配置、运行资料、日志或验收包加入 Git。

## 检查

```powershell
npm run typecheck
npm run lint
npm test -- --pool=threads --maxWorkers=2
# Renderer 空白启动浏览器检查（需 Edge，或指定 ASTERIUM_BROWSER_EXE）
npm run test:empty-start
npm run build:renderer
npm run sandbox:build
npm run build:studio-wake
npm run test:studio-wake-adapter
npm run build:automation-adapter
npm run test:automation-adapter
```

单元及 Renderer 测试使用 tests/fixtures 内的合成数据，不调用真实模型。两个 Adapter 测试脚本默认使用 --mock。构建 Renderer、SDK 或 helper 是源码编译检查，不生成桌面应用发行包。

首次代码基线建立前，能力条目为未绑定状态。基线存在并完成核验后，以纯文档提交写入已存在的代码 SHA，再执行 npm run check:capabilities。不得把未绑定状态记为通过，也不得用旧开发历史冒充本仓库的新基线。

## 后续打包流程

仅在确认准备生成新候选后运行：

```powershell
npm run package
```

Forge 会重新编译主进程、Preload、Renderer 及 Windows helper，输出到 out/。仓库默认配置未设置安装器 maker 或代码签名；package 仅生成应用目录。Windows 安装器可由单独冻结的构建配方生成，工具版本、配方哈希、最终源码提交和产物哈希必须随候选保存。构建安装器不等于普通账户安装验收通过。

打包后应使用新候选执行 test:startup、test:memory-sqlite、test:extensions 和 test:api-providers 等隔离桌面验收，可用 ASTERIUM_PACKAGED_EXE 显式选择新候选。不能用旧包替代新源码验收。真实 API、CLI 登录或外部宿主测试须单独明确授权并使用指定测试连接，不能直接遍历运行所有 smoke 脚本。

## 数据与权限

主进程资料和加密凭据位于 Electron userData，受管资料位于其 AsteriumData 子目录；项目工作目录由用户选择，默认项目根位于系统 Documents 下的 Asterium Projects。开发与打包实例的数据目录可能不同。隔离测试应为新进程显式指定 --user-data-dir，不复用个人资料。

Windows AppContainer/Job 沙箱属于实验能力，默认关闭；Full 使用 Native，普通审批与持续信任不等于无沙箱许可。HTTP MCP、网页和远程服务不由本地进程沙箱隔离。参见 [命令审批](docs/native-command-approval.md)。

## 文档与第三方代码

- [API 连接](docs/api-connections-guide.md)
- [MCP 与 Skills](docs/api-extensions-guide.md)
- [自动化](docs/automations-user-guide.md)
- [外观](docs/appearance-customization.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)

上游代码的许可证保留在 third_party/。项目自身的分发许可尚待维护者明确；此说明不替代授权选择。
