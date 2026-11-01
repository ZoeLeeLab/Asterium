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
    "tools/installer/installer.nsh"
  ],
  "tests": [
    "tests/unit/generalSettings.test.ts",
    "tests/renderer/GeneralSettings.test.tsx",
    "tests/unit/desktopIpc.test.ts",
    "tests/unit/desktopLifecycle.test.ts",
    "tests/general-settings-smoke.mjs",
    "tests/renderer/SendShortcut.test.tsx",
    "tests/unit/desktopNotifications.test.ts",
    "tests/renderer/DesktopNotificationNavigation.test.tsx",
    "tests/unit/executionBackendRouter.test.ts",
    "tests/unit/betaIdentity.test.ts",
    "tests/unit/windowsInstallerConfig.test.ts"
  ],
  "docs": [
    "docs/release-status.md",
    "docs/data-isolation.md",
    "docs/development-and-validation.md",
    "docs/releases/0.1.0-beta.1-r1.md"
  ],
  "lastVerifiedCommit": "0379ef989c326fd2edae330ae129c7a768ad44cd"
}
---

桌面通用设置的当前代码入口、测试和权限边界见以上元数据。

Beta 固定使用独立安装身份和默认资料目录，保留显式 user-data-dir，不自动迁移旧资料。安装器为当前用户提供首次默认勾选的快捷方式选择及默认不勾选的完成页启动；记住取消选择，卸载保留资料。源码配置与单元检查不代表普通账户安装、重装、提权或实际页面已通过。

本条核验绑定已存在代码提交 `0379ef989c326fd2edae330ae129c7a768ad44cd`，不继承旧候选验收归属。构建和人工验收分别以新候选独立报告为准；模拟、源码及配置核验不代表真实服务或普通账户验收通过。

安装器自定义函数移到对应页面钩子内声明，确保 NSIS UI 宏与可执行文件常量已加载。首次失败的编译日志及中间产物独立保留；普通账户实际安装仍待验收。
