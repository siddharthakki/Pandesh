; Pandesh — Upgrade-Safe Shutdown (Inno Setup 6.7.3 Pascal Script)
; Included by pandesh-desktop.iss and pandesh-smoke.iss.
;
; Implements upgrade-safe shutdown:
; 1. Detects running processes executing from the target install directory ({app}).
; 2. Requests graceful shutdown of Electron via --shutdown-for-upgrade.
; 3. Requests authenticated shutdown of child Core process via POST /v1/core/shutdown.
; 4. Waits for verified process termination with bounded timeout.
; 5. If files remain locked, identifies actual blocking processes without killing unrelated node.exe.
; 6. Offers Retry and Cancel (never ignores file-lock failures).

[Code]
type
  TProcessEntry32 = record
    dwSize: DWORD;
    cntUsage: DWORD;
    th32ProcessID: DWORD;
    th32DefaultHeapID: UINT_PTR;
    th32ModuleID: DWORD;
    cntThreads: DWORD;
    th32ParentProcessID: DWORD;
    pcPriClassBase: Longint;
    dwFlags: DWORD;
    szExeFile: array[0..259] of WideChar;
  end;

function CreateToolhelp32Snapshot(dwFlags, th32ProcessID: DWORD): THandle;
  external 'CreateToolhelp32Snapshot@kernel32.dll stdcall';
function Process32First(hSnapshot: THandle; var lppe: TProcessEntry32): BOOL;
  external 'Process32FirstW@kernel32.dll stdcall';
function Process32Next(hSnapshot: THandle; var lppe: TProcessEntry32): BOOL;
  external 'Process32NextW@kernel32.dll stdcall';
function CloseHandle(hObject: THandle): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';
function OpenProcess(dwDesiredAccess: DWORD; bInheritHandle: BOOL; dwProcessId: DWORD): THandle;
  external 'OpenProcess@kernel32.dll stdcall';
function QueryFullProcessImageName(hProcess: THandle; dwFlags: DWORD; lpExeName: String; var lpdwSize: DWORD): BOOL;
  external 'QueryFullProcessImageNameW@kernel32.dll stdcall';

function GetProcessPath(Pid: DWORD): String;
var
  hProcess: THandle;
  Size: DWORD;
  Buf: String;
begin
  Result := '';
  hProcess := OpenProcess($1000, False, Pid); // PROCESS_QUERY_LIMITED_INFORMATION = $1000
  if hProcess <> 0 then
  begin
    Size := 1024;
    SetLength(Buf, Size);
    if QueryFullProcessImageName(hProcess, 0, Buf, Size) then
    begin
      Result := Copy(Buf, 1, Size);
    end;
    CloseHandle(hProcess);
  end;
end;

function WideCharArrayToString(const Arr: array of WideChar): String;
var
  I: Integer;
begin
  Result := '';
  for I := 0 to 259 do
  begin
    if Arr[I] = #0 then Break;
    Result := Result + Arr[I];
  end;
end;

function FindRunningProcessesInDir(const TargetDir: String; var FoundList: String): Integer;
var
  Snapshot: THandle;
  Entry: TProcessEntry32;
  Pid: DWORD;
  ExePath: String;
  TargetPrefix: String;
  ExeName: String;
  Count: Integer;
begin
  Count := 0;
  FoundList := '';
  TargetPrefix := Uppercase(TargetDir);
  if (Length(TargetPrefix) > 0) and (TargetPrefix[Length(TargetPrefix)] <> '\') then
    TargetPrefix := TargetPrefix + '\';
  if Length(TargetPrefix) < 5 then
    Exit;

  Snapshot := CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS = 2
  if Snapshot <> THandle(-1) then
  begin
    Entry.dwSize := SizeOf(Entry);
    if Process32First(Snapshot, Entry) then
    begin
      repeat
        Pid := Entry.th32ProcessID;
        if Pid > 4 then
        begin
          ExePath := GetProcessPath(Pid);
          if ExePath <> '' then
          begin
            if Pos(TargetPrefix, Uppercase(ExePath)) = 1 then
            begin
              Count := Count + 1;
              ExeName := WideCharArrayToString(Entry.szExeFile);
              if ExeName = '' then
                ExeName := ExtractFileName(ExePath);
              if FoundList <> '' then
                FoundList := FoundList + #13#10;
              FoundList := FoundList + '  - ' + ExeName + ' (PID ' + IntToStr(Pid) + ')';
            end;
          end;
        end;
      until not Process32Next(Snapshot, Entry);
    end;
    CloseHandle(Snapshot);
  end;
  Result := Count;
end;

procedure RequestGracefulShutdown(const TargetDir: String);
var
  PandeshExe: String;
  ResultCode: Integer;
  DataDir, CoreJson, CoreToken: String;
  JsonContent, TokenContent: AnsiString;
  PortStr, TokenStr, CurlArgs: String;
  P, PEnd: Integer;
begin
  PandeshExe := TargetDir + '\electron\Pandesh.exe';
  if FileExists(PandeshExe) then
  begin
    Log('Requesting graceful Electron shutdown via ' + PandeshExe + ' "' + TargetDir + '\app" --shutdown-for-upgrade');
    Exec(PandeshExe, '"' + TargetDir + '\app" --shutdown-for-upgrade', TargetDir, SW_HIDE, ewNoWait, ResultCode);
  end;

  DataDir := ExpandConstant('{localappdata}\KarkeDikha\desktop');
  CoreJson := DataDir + '\core.json';
  CoreToken := DataDir + '\core.token';
  if FileExists(CoreJson) and FileExists(CoreToken) then
  begin
    if LoadStringFromFile(CoreJson, JsonContent) and LoadStringFromFile(CoreToken, TokenContent) then
    begin
      TokenStr := Trim(String(TokenContent));
      P := Pos('"port":', String(JsonContent));
      if P > 0 then
      begin
        P := P + 7;
        while (P <= Length(JsonContent)) and ((JsonContent[P] = ' ') or (JsonContent[P] = #9)) do
          P := P + 1;
        PEnd := P;
        while (PEnd <= Length(JsonContent)) and (JsonContent[PEnd] >= '0') and (JsonContent[PEnd] <= '9') do
          PEnd := PEnd + 1;
        PortStr := Copy(String(JsonContent), P, PEnd - P);
        if (PortStr <> '') and (TokenStr <> '') then
        begin
          Log('Requesting authenticated Core shutdown at port ' + PortStr);
          CurlArgs := '--connect-timeout 2 -m 3 -s -X POST http://127.0.0.1:' + PortStr + '/v1/core/shutdown -H "Authorization: Bearer ' + TokenStr + '" -H "Idempotency-Key: upgrade-shutdown" -H "Content-Type: application/json" -d "{}"';
          if FileExists(ExpandConstant('{sys}\curl.exe')) then
            Exec(ExpandConstant('{sys}\curl.exe'), CurlArgs, '', SW_HIDE, ewWaitUntilTerminated, ResultCode)
          else
            Exec('curl.exe', CurlArgs, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
        end;
      end;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  InstallDir: String;
  FoundList: String;
  Count, Attempt: Integer;
  UserChoice: Integer;
  PromptMsg: String;
begin
  Result := '';
  NeedsRestart := False;
  InstallDir := ExpandConstant('{app}');

  if not DirExists(InstallDir) then
    Exit;

  while True do
  begin
    Count := FindRunningProcessesInDir(InstallDir, FoundList);
    if Count = 0 then
    begin
      Log('No running processes found in ' + InstallDir);
      Exit;
    end;

    Log('Found ' + IntToStr(Count) + ' running process(es) in ' + InstallDir + ': ' + FoundList);
    RequestGracefulShutdown(InstallDir);

    // Bounded timeout: wait up to 10 seconds (50 x 200ms) for verified process termination
    for Attempt := 1 to 50 do
    begin
      Sleep(200);
      Count := FindRunningProcessesInDir(InstallDir, FoundList);
      if Count = 0 then
      begin
        Log('All processes in ' + InstallDir + ' have terminated successfully');
        Exit;
      end;
    end;

    Log('Processes remained locked after shutdown timeout: ' + FoundList);
    if WizardSilent then
    begin
      Result := 'Setup was unable to automatically close all Pandesh applications in ' + InstallDir + ':' + #13#10 + FoundList;
      Exit;
    end;

    PromptMsg := 'Setup detected that the following Pandesh applications are currently running and could not be automatically closed:' + #13#10#13#10 +
                 FoundList + #13#10#13#10 +
                 'Please close these applications to continue with the upgrade.' + #13#10#13#10 +
                 'Click Retry to try again, or Cancel to exit Setup.';

    UserChoice := MsgBox(PromptMsg, mbError, MB_RETRYCANCEL);
    if UserChoice <> IDRETRY then
    begin
      Result := 'Setup was cancelled because applications in the installation directory are still running.';
      Exit;
    end;
  end;
end;
