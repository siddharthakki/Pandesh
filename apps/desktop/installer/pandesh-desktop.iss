; Pandesh — per-user Windows installer (Inno Setup 6.7.3)
; Consumed by apps/desktop/scripts/package-installer.mjs
; Do not package secrets; user data remains under LocalAppData.
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

#define MyAppName "Pandesh"
#define MyAppPublisher "KarkeDikha"
; Must live next to Electron DLLs (same folder as electron.exe).
#define MyAppExeName "electron\Pandesh.exe"
#define MyAppParams """{app}\app"""

[Setup]
AppId={{8F3C2A91-6B4E-4D17-9C5A-2E8F0B7D4A11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutputDir}
OutputBaseFilename=Pandesh-Setup
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

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: {#MyAppParams}; WorkingDir: "{app}"; Comment: "Pandesh (local AI assistant)"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: {#MyAppParams}; WorkingDir: "{app}"; Comment: "Pandesh (local AI assistant)"

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: {#MyAppParams}; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.tmp"

#include "upgrade-shutdown.iss"
