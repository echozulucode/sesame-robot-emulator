; NSIS installer hooks — Phase 5 T6.
;
; One job: make the licence texts REACHABLE by someone who has only ever seen
; the installer.
;
; The obligation the audit found (docs/findings/LICENSE-AUDIT.md §3) is not
; "ship the GPL text somewhere in the tree"; it is that the licence accompanies
; the binary, and a file a recipient never encounters is not accompanying
; anything. Three things carry it, and this file is the third:
;
;   1. the installer's licence page, which is licenses\README.txt and which
;      every non-silent install shows before a byte is written;
;   2. `licenses\` beside the executable, installed as Tauri resources and
;      checked file-by-file by `just tauri-install`;
;   3. a Start Menu entry next to the app's own, so it is findable a year later
;      by someone who has forgotten where the app was installed.
;
; An "Open-source licences" item inside the application window would be better
; still, and belongs in `apps/web/src/desktop/DesktopResources.tsx`, which this
; workstream does not own. It is named in T6's finding rather than left implied.
;
; The uninstall hook removes what the install hook created. Anything else here
; would be a file the uninstaller leaves behind, which `just tauri-install`
; asserts against.

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME} licences.lnk" "$INSTDIR\licenses"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\${PRODUCTNAME} licences.lnk"
!macroend
