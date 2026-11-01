---
{
  "name": "桌面通用设置",
  "id": "asterium.desktop-settings",
  "appliesTo": [
    "api",
    "local_cli",
    "existing_thread"
  ],
  "protocols": [
    "internal"
  ],
  "permissionBoundary": "仅桌面用户通过已校验的固定 IPC 修改本机设置，不提供给伙伴工具，不授予工作区、扩展或成员权限。",
  "status": "experimental",
  "codeEntries": [
    "src/shared/generalSettings.ts",
    "src/main/settings/GeneralSettingsStore.ts",
    "src/renderer/components/settings/GeneralSettingsView.tsx",
    "src/renderer/components/settings/AboutSettingsView.tsx",
    "src/renderer/pages/SettingsPage.tsx",
    "src/main/settings/DesktopLifecycle.ts",
    "src/main/main.ts",
    "src/renderer/app/sendShortcut.ts",
    "src/main/settings/DesktopNotifications.ts",
    "src/main/settings/windowsStartup.ts",
    "src/renderer/app/DesktopNotificationNavigation.tsx",
    "src/main/execution/ExecutionBackendRouter.ts",
    "src/main/agentIpc.ts",
    "src/main/settings/betaIdentity.ts",
    "src/shared/appRelease.ts",
    "scripts/windows-installer-config.mjs",
    "scripts/build-windows-candidate.mjs",
    "scripts/windows-installer-templates.mjs",
    "scripts/prepare-source-materials.mjs",
    "tools/installer/installer.nsh",
    "tools/installer/windows-shell.nsh",
    "src/shared/appUpdates.ts",
    "src/main/settings/AppUpdateService.ts",
    "src/renderer/app/useAppUpdates.ts",
    "src/renderer/app/UpdateNotice.tsx"
  ],
  "tests": [
    "tests/unit/generalSettings.test.ts",
    "tests/renderer/GeneralSettings.test.tsx",
    "tests/renderer/AboutSettings.test.tsx",
    "tests/empty-start-browser-smoke.mjs",
    "tests/unit/desktopIpc.test.ts",
    "tests/unit/desktopLifecycle.test.ts",
    "tests/general-settings-smoke.mjs",
    "tests/renderer/SendShortcut.test.tsx",
    "tests/unit/desktopNotifications.test.ts",
    "tests/renderer/DesktopNotificationNavigation.test.tsx",
    "tests/unit/executionBackendRouter.test.ts",
    "tests/unit/betaIdentity.test.ts",
    "tests/unit/windowsInstallerConfig.test.ts",
    "tests/unit/windowsInstallerTemplates.test.ts",
    "tests/unit/sourceMaterials.test.ts",
    "tests/windows-installer-shell-smoke.mjs",
    "tests/unit/appUpdateService.test.ts",
    "tests/renderer/AppUpdates.test.tsx"
  ],
  "docs": [
    "docs/release-status.md",
    "docs/data-isolation.md",
    "docs/development-and-validation.md",
    "docs/releases/0.1.0-beta.1-r1.md",
    "docs/releases/0.1.0-beta.1-about-fix.md",
    "docs/client-updates.md",
    "docs/releases/0.1.0-beta.1-r2.md",
    "docs/releases/0.1.0-beta.1-r3-licensing.md",
    "COPYRIGHT.md",
    "ASSET_LICENSE.md",
    "BRANDING.md",
    "CREDITS.md"
  ],
  "lastVerifiedCommit": "bee7e4bfc1a3076b42cdeb69868552b748879d73"
}
---

桌面通用设置的当前代码入口、测试和权限边界见以上元数据。

Beta 固定使用独立安装身份和默认资料目录，保留显式 user-data-dir，不自动迁移旧资料。安装器为当前用户提供首次默认勾选的快捷方式选择及默认不勾选的完成页启动；记住取消选择，卸载保留资料。源码配置与单元检查不代表普通账户安装、重装、提权或实际页面已通过。

此前关于页阶段核验绑定已存在代码提交 `ae4e3e55f9afc1d07ed9d97d6b8927ca83f782d1`，不继承旧候选验收归属。安装器配置此前绑定的代码提交 `a8e9907cb3c56510000f04902ed9d84005a87fe4` 保留在历史中，本次未修改该实现。构建和人工验收分别以新候选独立报告为准；模拟、源码及配置核验不代表真实服务或普通账户验收通过。

安装器自定义函数移到对应页面钩子内声明，确保 NSIS UI 宏与可执行文件常量已加载。首次失败的编译日志及中间产物独立保留；普通账户实际安装仍待验收。

默认安装文件夹固定为 Asterium Beta，程序仍为 Asterium.exe；NSIS 中文 include 使用明确 UTF-8 BOM。安装标识、资料目录和快捷方式继续独立，后续 Beta 沿用。

当前用户安装明确关闭 packElevateHelper，不将未使用的 elevate.exe 注入应用载荷。最终安装器须与审计的应用文件逐项一致，源配置检查不代替普通账户安装验收。

关于页已启用，展示来源于 package.json 的版本、产品定位、数据与连接简述和当前发行状态。第三方声明及收集的许可证原文按需离线加载为纯文本，不触发外部访问或授予新权限；项目许可证、签名及更新功能的未完成状态明确展示。相关设置 32 项回归及 7 项隔离浏览器检查通过，未重新运行 CLI 联调或完整产品验收；此修复尚未纳入新的应用包，具体边界见关于页补齐记录。


## 首版补齐阶段

本轮精简关于页，接入用户控制的 GitHub Releases 检查、下载、取消、大小及 SHA-256 校验、安装前复核和退出确认；自动检查与测试版偏好持久化。更新固定使用维护者配置的公开源，无私人 Token，不向伙伴工具开放，不自动下载或安装。当前公开仓库未绑定，候选显示未配置并且不请求网络；模拟测试与真实 GitHub 升级严格区分。未配置代码签名，项目许可证尚未落地。

当前 lastVerifiedCommit 绑定已存在代码提交 `a4a5ace1446b0a2601099cae337c21fbb56a8fb8`，之前的真实来源 `ae4e3e55f9afc1d07ed9d97d6b8927ca83f782d1` 仍在历史中保留。全套检查及新包验收结果另见独立候选报告；不继承旧候选验收归属。


桌面测试维护阶段将 general-settings-smoke 的旧入口与示例状态假设更新为明确的隔离合成夹具，并核对关于页未配置更新源。产品实现未变，当前核验源更新为已存在提交 `9de9e5390fad6f4893ec4fce01ccd532bcbd7084`；实际打包桌面执行仍以新候选报告为准，不把脚本静态检查写成运行通过。其他四条首版补齐能力继续引用原实现提交。

## 许可与安装器收尾阶段

本阶段源码已加入项目许可、素材范围、品牌说明和致谢，关于页按需展示实际原文；此前段落中的“许可证尚未落地”描述原阶段候选。安装器的 shell 操作改用 Windows COM 与现有 System 插件，保持当前用户、Beta 身份和资料边界，没有改变伙伴工具、连接认证或原生权限模式。原生诊断仅验证合成链接与合成 AppID，不代表新安装器、真实固定项或卸载重装已验收。详见 [本轮版本记录](../../releases/0.1.0-beta.1-r3-licensing.md)。

本阶段绑定已存在代码提交 `b9ceac7c15e337bc7f39cb328c8ca617b388b12b`，以纯文档核验提交更新来源；不改变前述历史阶段的实际归属。207 个测试文件中 1623 项通过、0 失败、2 个既有 TODO；类型、lint、能力、依赖、源码隐私与链接、声明原文、14 份源码材料、隔离浏览器和原生诊断检查通过。未构建本阶段产品安装包，完整包与普通账户人工验收仍待后续候选。其余 15 条能力条目未受功能影响，保留各自原真实引用。

### 公开更新源地址绑定（2026-11-01）

维护者已手动创建 `ZoeLeeLab/Asterium`，源码已绑定该公开地址。只读核验为公开空仓库，分支及 Release 列表为空；真实资产下载及升级验收仍待发行版本就绪后进行。已配置地址的源码实例可以发起公开检查；旧候选不受此次源码修改影响。本阶段不新增下载权限或自动安装，也不上传任何内容。lastVerifiedCommit 在代码提交存在并核验后以纯文档提交绑定，不用旧候选测试证明本次绑定。

本阶段以纯文档提交绑定已存在基线 `bee7e4bfc1a3076b42cdeb69868552b748879d73`。运行通道和更新源实现来自 `7a1f2f3c69eabdd6c20bf220b22ee9a10f8132c6`，该提交的更新/关于页 20 项针对性测试通过；后续两笔仅把源码维护的桌面脚本更新为已配置公开源的断言并等待 IPC 状态，语法/静态检查通过，不将其写为打包执行已通过。本轮最终全套检查与新包的实际桌面执行另记候选收据。其余 15 条能力保留原真实基线。
