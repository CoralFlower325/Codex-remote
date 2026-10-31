!macro customInstall
  # Launch the installed executable, avoiding stale or unresolvable shortcuts.
  # Keep the standard StartApp macro's unelevated ExecShellAsUser behavior.
  StrCpy $launchLink "$appExe"
!macroend
