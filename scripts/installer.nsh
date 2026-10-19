; NSIS 自定义安装脚本
; 功能：
; 1. 用户选择安装目录后，自动在路径末尾追加 "youdu" 子目录
; 2. 安装前：检测到旧数据/备份时提示保留还是删除
; 3. 卸载前：静默模式保留数据；非静默按数据位置提示
;    - 程序目录：提示已手动备份？确认后全部删除
;    - 自定义目录：提示保留数据还是删除
; 4. 安装后：恢复保留的 data/

; 禁用 NSIS 6010 警告
!pragma warning disable 6010

; 定义目录选择页面的 leave 回调（在 MUI_PAGE_DIRECTORY 插入前定义）
!define MUI_PAGE_CUSTOM_FUNCTION_LEAVE youduDirLeave

Function youduDirLeave
  ; 取 $INSTDIR 末尾 6 个字符（"\youdu" 长度为 6）
  StrLen $R0 $INSTDIR
  IntCmp $R0 6 youduDirLeave_short youduDirLeave_short 0
  IntOp $R0 $R0 - 6
  StrCpy $R1 $INSTDIR 6 $R0
  Goto youduDirLeave_check

  youduDirLeave_short:
  StrCpy $R1 $INSTDIR

  youduDirLeave_check:
  ; 检查末尾是否为 "\youdu"
  StrCmp $R1 "\youdu" youduDirLeave_end 0

  ; 不以 \youdu 结尾，追加 \youdu
  StrCpy $INSTDIR "$INSTDIR\youdu"

  youduDirLeave_end:
FunctionEnd

; ================================================================
; 安装前：检测旧数据/备份，提示保留还是删除
; ================================================================
!macro customInit
  ; 注意：NSIS IfFileExists 不支持通配符，必须检查目录本身路径

  ; 1. 检查是否有备份数据（覆盖安装场景：旧版本静默卸载时移走的 data）
  IfFileExists "$INSTDIR\..\youdu-data-backup" 0 yd_init_check_data

  ; 有备份，弹对话框询问保留还是删除
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "检测到已有幽读数据，是否保留？$\r$\n$\r$\n选「是」：保留数据，升级后可继续阅读$\r$\n选「否」：删除全部数据，全新安装" IDYES yd_init_keep_backup IDNO yd_init_del_backup

  yd_init_keep_backup:
    ; 保留备份，等 customInstall 恢复
    Goto yd_init_done

  yd_init_del_backup:
    ; 用户选删除，删备份
    RMDir /r "$INSTDIR\..\youdu-data-backup"
    Goto yd_init_done

  yd_init_check_data:
  ; 2. 检查 $INSTDIR\data 是否存在（非覆盖安装但有旧数据）
  IfFileExists "$INSTDIR\data" 0 yd_init_check_appdata

  ; 有旧数据，弹对话框询问保留还是删除
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "检测到已有幽读数据（安装目录\data\），是否保留？$\r$\n$\r$\n选「是」：保留数据，升级后可继续阅读$\r$\n选「否」：删除全部数据，全新安装" IDYES yd_init_keep IDNO yd_init_del

  yd_init_keep:
    ; 把 data 积到安装目录旁边（同盘 Rename 瞬时完成），卸载旧版本删不到
    Rename "$INSTDIR\data" "$INSTDIR\..\youdu-data-backup"
    Goto yd_init_done

  yd_init_del:
    ; 用户选删除，直接删 data
    RMDir /r "$INSTDIR\data"
    Goto yd_init_done

  yd_init_check_appdata:
  ; 3. 检查 %APPDATA% 下的旧版本数据（0.x~1.x 旧版本数据在 APPDATA 而非 exe/data）
  IfFileExists "$APPDATA\youdu\youdu.db" 0 yd_init_nodata

  ; 有旧数据，弹对话框询问保留还是删除
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "检测到已有幽读数据，是否保留？$\r$\n$\r$\n选「是」：保留数据，升级后可继续阅读$\r$\n选「否」：删除全部数据，全新安装" IDYES yd_init_keep_appdata IDNO yd_init_del_appdata

  yd_init_keep_appdata:
    ; 保留旧数据，启动时自动迁移到 $INSTDIR\data
    Goto yd_init_done

  yd_init_del_appdata:
    ; 删除旧数据
    RMDir /r "$APPDATA\youdu"
    RMDir /r "$APPDATA\youdu-local"
    RMDir /r "$APPDATA\YouduLocal"
    RMDir /r "$APPDATA\幽读本地版"
    Goto yd_init_done


  yd_init_nodata:
  yd_init_done:
!macroend

; ================================================================
; 卸载前：静默模式保留数据，非静默按数据位置提示
; ================================================================
!macro customUnInit
  ; 静默模式（覆盖安装时 NSIS 自动静默卸载旧版本）：保留数据，不移除
  ; 这样新版本安装时 customInit 能检测到备份并提示保留/删除
  ${If} ${Silent}
    IfFileExists "$INSTDIR\data" 0 +2
      Rename "$INSTDIR\data" "$INSTDIR\..\youdu-data-backup"
    Goto yd_un_done
  ${EndIf}

  ; 非静默模式：读取 youdu-config.json 判断数据位置
  ; PowerShell 检查是否有自定义 dataRoot，有则 exit 1（自定义目录），无则 exit 0（程序目录）
  nsExec::Exec "powershell -NoProfile -NonInteractive -Command \"try { $$p = '$APPDATA\Youdu\youdu-config.json'; if (Test-Path $$p) { $$c = Get-Content $$p -Raw -Encoding UTF8 | ConvertFrom-Json; if ($$c.dataRoot -and (Test-Path $$c.dataRoot)) { exit 1 } else { exit 0 } } else { exit 0 } } catch { exit 0 }\""
  Pop $R0

  ; 检查是否数据在自定义目录（$R0 = "1"）
  StrCmp $R0 "1" yd_un_custom_dir 0

  ; 数据在程序目录：提示是否已手动备份，确认后全部删除
  MessageBox MB_OKCANCEL|MB_ICONQUESTION|MB_DEFBUTTON2 "卸载将删除所有数据（含书库、设置、封面等）。$\r$\n$\r$\n请确认您已手动备份重要数据。$\r$\n$\r$\n选「确认」：继续卸载并删除全部数据（不可恢复）$\r$\n选「取消」：退出卸载向导" IDOK yd_un_del_all IDCANCEL yd_un_cancel
  Goto yd_un_done

  yd_un_cancel:
    Quit

  yd_un_custom_dir:
    ; 数据在自定义目录：提示保存或删除
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "检测到数据在自定义目录。$\r$\n$\r$\n选「是」：保留数据（仅卸载程序，不删数据）$\r$\n选「否」：删除全部数据（不可恢复）" IDYES yd_un_keep_custom IDNO yd_un_del_all
    Goto yd_un_done

  yd_un_keep_custom:
    ; 只删程序文件和程序目录数据，不删自定义目录数据
    RMDir /r "$INSTDIR\data"
    RMDir /r "$INSTDIR\..\youdu-data-backup"
    Goto yd_un_done

  yd_un_del_all:
    ; 删除所有数据
    RMDir /r "$INSTDIR\data"
    RMDir /r "$APPDATA\youdu"
    RMDir /r "$APPDATA\Youdu"
    RMDir /r "$APPDATA\youdu-local"
    RMDir /r "$APPDATA\YouduLocal"
    RMDir /r "$APPDATA\幽读本地版"
    RMDir /r "$INSTDIR\..\youdu-data-backup"
    ; 删除自定义数据目录
    nsExec::Exec "powershell -NoProfile -NonInteractive -Command \"try { $$p = '$APPDATA\Youdu\youdu-config.json'; if (Test-Path $$p) { $$c = Get-Content $$p -Raw -Encoding UTF8 | ConvertFrom-Json; if ($$c.dataRoot -and (Test-Path $$c.dataRoot)) { Remove-Item -LiteralPath $$c.dataRoot -Recurse -Force } } } catch {}\""

  yd_un_done:
!macroend

; ================================================================
; 安装后：恢复保留的 data/
; ================================================================
!macro customInstall
  ; 恢复 data/（同盘符 Rename，瞬时完成）
  ; 注意：NSIS IfFileExists 不支持通配符，必须检查目录本身路径
  IfFileExists "$INSTDIR\..\youdu-data-backup" 0 +3
    Rename "$INSTDIR\..\youdu-data-backup" "$INSTDIR\data"
    Goto +2
  ; 如果 data/ 已存在（未被移走），删除残留备份
  IfFileExists "$INSTDIR\..\youdu-data-backup" 0 +2
    RMDir /r "$INSTDIR\..\youdu-data-backup"
!macroend
