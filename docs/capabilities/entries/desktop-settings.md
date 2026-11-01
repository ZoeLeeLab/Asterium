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
    "tools/installer/installer.nsh",
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
    "docs/releases/0.1.0-beta.1-r2.md"
  ],
  "lastVerifiedCommit": "9de9e5390fad6f4893ec4fce01ccd532bcbd7084"
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
