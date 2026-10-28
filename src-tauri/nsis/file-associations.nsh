; Replace Tauri's default-association macros before the generated calls run.
!macroundef APP_ASSOCIATE
!macro APP_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}" "" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\shell\open" "" "${COMMANDTEXT}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}"
!macroend

!macroundef APP_UNASSOCIATE
!macro APP_UNASSOCIATE EXT FILECLASS
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids"
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\${FILECLASS}\shell\open\command" ""
  StrCmp $R0 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"' 0 +2
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${FILECLASS}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro UPDATEFILEASSOC
!macroend
