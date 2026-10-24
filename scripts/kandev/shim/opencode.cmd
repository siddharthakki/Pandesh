@ECHO off
REM Kandev v0.97.0 launches OpenCode with the v1-only flag "--log-level ERROR"; OpenCode v2 needs lowercase.
REM Remove once a Kandev release ships managed OpenCode v2 support (upstream PR #4014, merged after v0.97.0).
REM start-kandev.ps1 redirects APPDATA to the isolated worker profile, so the real binary path comes from KKD_OPENCODE_EXE.
SETLOCAL
SET "ARGS=%*"
IF DEFINED ARGS SET "ARGS=%ARGS:--log-level ERROR=--log-level error%"
IF NOT DEFINED KKD_OPENCODE_EXE SET "KKD_OPENCODE_EXE=%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe"
"%KKD_OPENCODE_EXE%" %ARGS%
