@ECHO off
REM Kandev v0.97.0 probes Hermes with "hermes acp --check" under a ~5 s timeout, but the real check needs 3-5 s of Python imports
REM (longer while Kandev probes every agent at once), so Hermes was reported "not installed" although it works.
REM start-kandev.ps1 runs the REAL check once, under the same isolated worker profile, and leaves hermes-acp-check.ok only if it passed.
REM This shim answers that one flag from the marker; every other invocation (including the real ACP session) runs the real binary.
REM KKD_HERMES_EXE is resolved by start-kandev.ps1 before LOCALAPPDATA is redirected.
SETLOCAL
IF NOT DEFINED KKD_HERMES_EXE SET "KKD_HERMES_EXE=hermes.exe"
IF DEFINED KKD_SHIM_LOG ECHO %DATE% %TIME% hermes %* >> "%KKD_SHIM_LOG%"
IF /I "%~1 %~2"=="acp --check" IF DEFINED KKD_HERMES_CHECK_OK IF EXIST "%KKD_HERMES_CHECK_OK%" (
  ECHO Hermes ACP check OK ^(verified when Kandev started^)
  EXIT /B 0
)
"%KKD_HERMES_EXE%" %*
EXIT /B %ERRORLEVEL%
