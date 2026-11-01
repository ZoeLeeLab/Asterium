!ifndef ASTERIUM_WINDOWS_SHELL_INCLUDED
!define ASTERIUM_WINDOWS_SHELL_INCLUDED
!include "LogicLib.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"

; Asterium implementation using Windows COM and the stock NSIS System plug-in.
; HRESULT is exposed for diagnostics; shell integration remains best effort.
Var AsteriumShellResult

!macro AsteriumShellSaveRegisters
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
!macroend

!macro AsteriumShellRestoreRegisters
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro AsteriumSetLinkAppId LINK APPID
  !insertmacro AsteriumShellSaveRegisters
  StrCpy $AsteriumShellResult -2147467259
  System::Call 'ole32::CoInitialize(p 0)i.r6'
  ${If} $6 >= 0
    StrCpy $0 0
    StrCpy $1 0
    StrCpy $2 0
    System::Call 'ole32::CoCreateInstance(g "${CLSID_ShellLink}",p 0,i 1,g "${IID_IShellLinkW}",*p.r0)i.r9'
    ${If} $9 >= 0
      ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)i.r9'
      ${If} $9 >= 0
        ${IPersistFile::Load} $1 '("${LINK}",2)i.r9'
        ${If} $9 >= 0
          ${IUnknown::QueryInterface} $0 '("${IID_IPropertyStore}",.r2)i.r9'
          ${If} $9 >= 0
            System::Call '*${SYSSTRUCT_PROPERTYKEY}(${PKEY_AppUserModel_ID})p.r3'
            System::Call '*(&w${NSIS_MAX_STRLEN} "${APPID}")p.r5'
            ; PROPVARIANT: VT_LPWSTR, six reserved bytes, pointer and padding.
            System::Call '*(i ${VT_LPWSTR},i 0,p r5,i 0)p.r4'
            ${If} $3 P<> 0
            ${AndIf} $4 P<> 0
            ${AndIf} $5 P<> 0
              ${IPropertyStore::SetValue} $2 '($3,$4)i.r9'
              ${If} $9 >= 0
                ${IPropertyStore::Commit} $2 '()i.r9'
                ${If} $9 >= 0
                  ${IPersistFile::Save} $1 '("${LINK}",1)i.r9'
                ${EndIf}
              ${EndIf}
            ${Else}
              StrCpy $9 -2147024882
            ${EndIf}
            System::Free $4
            System::Free $5
            System::Free $3
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    StrCpy $AsteriumShellResult $9
    ${If} $2 P<> 0
      ${IUnknown::Release} $2 ""
    ${EndIf}
    ${If} $1 P<> 0
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${If} $0 P<> 0
      ${IUnknown::Release} $0 ""
    ${EndIf}
    System::Call 'ole32::CoUninitialize()'
  ${Else}
    StrCpy $AsteriumShellResult $6
  ${EndIf}
  !insertmacro AsteriumShellRestoreRegisters
!macroend

!macro AsteriumUnpinShortcut LINK
  !insertmacro AsteriumShellSaveRegisters
  StrCpy $AsteriumShellResult 0
  ${If} ${FileExists} "${LINK}"
    System::Call 'ole32::CoInitialize(p 0)i.r6'
    ${If} $6 >= 0
      StrCpy $0 0
      StrCpy $1 0
      System::Call 'shell32::SHCreateItemFromParsingName(w "${LINK}",p 0,g "${IID_IShellItem}",*p.r0)i.r9'
      ${If} $9 >= 0
        System::Call 'ole32::CoCreateInstance(g "${CLSID_StartMenuPin}",p 0,i 1,g "${IID_IStartMenuPinnedList}",*p.r1)i.r9'
        ${If} $9 >= 0
          ${IStartMenuPinnedList::RemoveFromList} $1 '($0)i.r9'
        ${EndIf}
      ${EndIf}
      StrCpy $AsteriumShellResult $9
      ${If} $1 P<> 0
        ${IUnknown::Release} $1 ""
      ${EndIf}
      ${If} $0 P<> 0
        ${IUnknown::Release} $0 ""
      ${EndIf}
      System::Call 'ole32::CoUninitialize()'
    ${Else}
      StrCpy $AsteriumShellResult $6
    ${EndIf}
  ${EndIf}
  !insertmacro AsteriumShellRestoreRegisters
!macroend

!macro AsteriumClearDestinations APPID
  !insertmacro AsteriumShellSaveRegisters
  StrCpy $AsteriumShellResult 0
  System::Call 'ole32::CoInitialize(p 0)i.r6'
  ${If} $6 >= 0
    StrCpy $0 0
    ; IApplicationDestinations: SetAppID (3), RemoveAllDestinations (5).
    System::Call 'ole32::CoCreateInstance(g "{86C14003-4D6B-4EF3-A7B4-0506663B2E68}",p 0,i 1,g "{12337D35-94C6-48A0-BCE7-6A9C69D4D600}",*p.r0)i.r9'
    ${If} $9 >= 0
      System::Call '$0->3(w "${APPID}")i.r9'
      ${If} $9 >= 0
        System::Call '$0->5()i.r9'
      ${EndIf}
      ${IUnknown::Release} $0 ""
    ${EndIf}
    ${If} $9 < 0
      StrCpy $AsteriumShellResult $9
    ${EndIf}
    StrCpy $0 0
    ; ICustomDestinationList: DeleteList (10).
    System::Call 'ole32::CoCreateInstance(g "{77F10CF0-3DB5-4966-B520-B7C54FD35ED6}",p 0,i 1,g "{6332DEBF-87B5-4670-90C0-5E57B408A49E}",*p.r0)i.r9'
    ${If} $9 >= 0
      System::Call '$0->10(w "${APPID}")i.r9'
      ${IUnknown::Release} $0 ""
    ${EndIf}
    ${If} $9 < 0
      StrCpy $AsteriumShellResult $9
    ${EndIf}
    System::Call 'ole32::CoUninitialize()'
  ${Else}
    StrCpy $AsteriumShellResult $6
  ${EndIf}
  !insertmacro AsteriumShellRestoreRegisters
!macroend
!endif
