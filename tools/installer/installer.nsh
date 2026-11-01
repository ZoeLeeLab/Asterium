!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!define ASTERIUM_BETA_SETTINGS_KEY "Software\Asterium\Beta"
!define ASTERIUM_BETA_LINK "Asterium Beta.lnk"

!ifndef BUILD_UNINSTALLER
  Var AsteriumDesktopChoice
  Var AsteriumDesktopCheckbox

  !macro customInstallMode
    StrCpy $isForceCurrentInstall "1"
  !macroend

  !macro customInit
    SetShellVarContext current
    ClearErrors
    ReadRegDWORD $AsteriumDesktopChoice HKCU "${ASTERIUM_BETA_SETTINGS_KEY}" "DesktopShortcut"
    ${If} ${Errors}
      StrCpy $AsteriumDesktopChoice ${BST_CHECKED}
    ${EndIf}
    ${If} ${Silent}
    ${AndIfNot} ${FileExists} "$DESKTOP\${ASTERIUM_BETA_LINK}"
      StrCpy $AsteriumDesktopChoice ${BST_UNCHECKED}
    ${EndIf}
  !macroend

  !macro customPageAfterChangeDir
    Page custom AsteriumOptionsPage AsteriumOptionsLeave
  !macroend

  Function AsteriumOptionsPage
    !insertmacro MUI_HEADER_TEXT "安装选项" "选择是否创建桌面快捷方式。"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateCheckbox} 0 20u 100% 20u "创建桌面快捷方式"
    Pop $AsteriumDesktopCheckbox
    ${NSD_SetState} $AsteriumDesktopCheckbox $AsteriumDesktopChoice
    nsDialogs::Show
  FunctionEnd

  Function AsteriumOptionsLeave
    ${NSD_GetState} $AsteriumDesktopCheckbox $AsteriumDesktopChoice
  FunctionEnd

  !macro customInstall
    SetShellVarContext current
    ${If} $AsteriumDesktopChoice == ${BST_CHECKED}
      CreateShortCut "$DESKTOP\${ASTERIUM_BETA_LINK}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${Else}
      Delete "$DESKTOP\${ASTERIUM_BETA_LINK}"
    ${EndIf}
    WriteRegDWORD HKCU "${ASTERIUM_BETA_SETTINGS_KEY}" "DesktopShortcut" $AsteriumDesktopChoice
  !macroend

  !macro customFinishPage
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_TEXT "立即打开星丛"
    !define MUI_FINISHPAGE_RUN_NOTCHECKED
    !define MUI_FINISHPAGE_RUN_FUNCTION "AsteriumLaunchAfterFinish"
    !insertmacro MUI_PAGE_FINISH
  !macroend

  Function AsteriumLaunchAfterFinish
    ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
  FunctionEnd
!else
  !macro customUnInstall
    SetShellVarContext current
    Delete "$DESKTOP\${ASTERIUM_BETA_LINK}"
    ; Keep the preference and application data. Never touch another channel.
  !macroend
!endif
