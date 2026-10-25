; Pandesh — per-user Windows installer (Inno Setup 6.7.3)
; Consumed by apps/desktop/scripts/package-installer.mjs
; SMOKE build only: distinct AppId so it never touches the owner install.; user data remains under LocalAppData.
;
; The AppId GUID below is the identity of the installed product and is
; deliberately UNCHANGED from the "Jarvis Desktop" builds: an existing
; installation must upgrade in place, keeping the user's settings, paired
; phones, conversations and stored Google credential. Only the names the
; person sees changed.

#ifndef SourceDir
  #error SourceDir must be defined (/DSourceDir=...)
#endif
#ifndef OutputDir
  #error OutputDir must be defined (/DOutputDir=...)
#endif
#ifndef IconFile
  #error IconFile must be defined (/DIconFile=...)
#endif
#ifndef MyAppVersion
  #error MyAppVersion must be defined (/DMyAppVersion=...) - it comes from apps/desktop/package.json
#endif

#define MyAppName "Pandesh Smoke"
#define MyAppPublisher "KarkeDikha"
; Must live next to Electron DLLs (same folder as electron.exe).
#define MyAppExeName "electron\Pandesh.exe"
#define MyAppParams """{app}\app"""

[Setup]
AppId={{6A1D9E40-2C7B-4F3A-8E55-0B9C7D2F1A63}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutputDir}
OutputBaseFilename=Pandesh-Smoke-Setup
SetupIconFile={#IconFile}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
CloseApplications=no
RestartApplications=no
; Uninstall removes Program Files under {app} only.
; %LOCALAPPDATA%\KarkeDikha\desktop (settings/logs/credentials) is preserved.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; Smoke test build: do not create desktop or Start Menu shortcuts to avoid polluting
; the host environment or triggering explorer.exe file locks.

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: {#MyAppParams}; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

#include "upgrade-shutdown.iss"
