<#
  Starts the local Kandev control plane that executes KarkeDikha development stories.
  Kandev (https://github.com/kdlbs/kandev, AGPL-3.0) is installed unmodified from npm at a pinned version and
  runs as a separate process; KKD only talks to it over localhost. See docs/KANDEV_INTEGRATION.md.

  Isolation: Kandev and every worker it launches (Claude Code, OpenCode, ...) get a clean, allow-listed environment
  whose HOME/USERPROFILE/APPDATA/XDG/CLAUDE_CONFIG_DIR point at a dedicated worker profile under the Kandev home.
  The user's own agent profiles (~/.claude, ~/.config/opencode with its plugins, MCP servers and memory), shell
  secrets and application data are not inherited. KKD Core fills the worker profile (core/runtime/kandev/workerProfile.ts).

  Exposure: Kandev ships with authentication off, so it must only ever listen on loopback. After start this script
  checks every listening socket of the whole Kandev process tree and kills the tree if any is not loopback.
  Kandev's own origin check also accepts any request whose Origin equals its Host, so a DNS-rebinding web page
  would get full access to a well-known address (127.0.0.1:38500). It therefore listens on a RANDOM loopback
  address (127.x.y.z) and a RANDOM port per start; both are written to %KandevHome%\endpoint.json, readable only by
  the current user. KKD Core reads that file. Any other local process of the same user can still find the socket
  (netstat), so this is browser/remote hardening, not process isolation.

  Usage:  powershell -File scripts\kandev\start-kandev.ps1 [-Port <fixed port, default random>] [-BindHost <127.x.y.z, default random>]
  Stop:   powershell -File scripts\kandev\stop-kandev.ps1
#>
param(
  [int]$Port = 0,
  [string]$BindHost = '',
  [string]$Version = '0.97.0',
  # Short on purpose: Kandev binds an AF_UNIX socket under its home and Windows caps that path at ~108 chars.
  [string]$KandevHome = (Join-Path $env:USERPROFILE '.kkd-kandev')
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg = Join-Path $KandevHome 'pkg'
$pidFile = Join-Path $KandevHome 'kandev.pid'
$workerHome = Join-Path $KandevHome 'worker-home'
$endpointFile = Join-Path $KandevHome 'endpoint.json'

function Get-ProcessTree([int]$root) {
  $all = Get-CimInstance Win32_Process
  $tree = New-Object System.Collections.Generic.List[int]
  $tree.Add($root)
  do {
    $added = $false
    foreach ($p in $all) {
      if ($tree.Contains([int]$p.ParentProcessId) -and -not $tree.Contains([int]$p.ProcessId)) { $tree.Add([int]$p.ProcessId); $added = $true }
    }
  } while ($added)
  return ,$tree  # the comma stops PowerShell unrolling a one-element list into an Int32
}

function Test-Loopback([string]$addr) { return ($addr -match '^127\.\d+\.\d+\.\d+$') -or $addr -eq '::1' }

function Assert-LoopbackOnly([int]$root) {
  $tree = Get-ProcessTree $root
  $exposed = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
    $tree.Contains([int]$_.OwningProcess) -and -not (Test-Loopback $_.LocalAddress)
  })
  $exposed += @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object {
    $tree.Contains([int]$_.OwningProcess) -and -not (Test-Loopback $_.LocalAddress)
  })
  if ($exposed.Count) {
    foreach ($id in $tree) { try { Stop-Process -Id $id -Force -ErrorAction Stop } catch {} }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    throw "Kandev listened on a non-loopback address ($(($exposed | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }) -join ', ')); stopped it. Kandev has no authentication and must stay on 127.0.0.1."
  }
}

# Already running? Use the recorded endpoint (it changes on every start).
if (Test-Path $endpointFile) {
  try {
    $ep = Get-Content $endpointFile -Raw | ConvertFrom-Json
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$($ep.url)/health"
    if ($r.StatusCode -eq 200) {
      if (Test-Path $pidFile) { Assert-LoopbackOnly ([int](Get-Content $pidFile)) }
      Write-Output "Kandev already running (loopback endpoint in $endpointFile)"; exit 0
    }
  } catch { if ($_.Exception.Message -like 'Kandev listened*') { throw } }
}
Remove-Item $endpointFile -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force $pkg | Out-Null
$exe = Join-Path $pkg 'node_modules\@kdlbs\runtime-win32-x64\bin\kandev.exe'
$installed = if (Test-Path (Join-Path $pkg 'node_modules\kandev\package.json')) { (Get-Content (Join-Path $pkg 'node_modules\kandev\package.json') | ConvertFrom-Json).version } else { '' }
if ($installed -ne $Version) {
  Write-Output "Installing kandev@$Version into $pkg (no install scripts) ..."
  Push-Location $pkg
  try {
    if (-not (Test-Path 'package.json')) { '{ "name": "kkd-kandev-runtime", "private": true }' | Out-File -Encoding ascii package.json }
    npm install "kandev@$Version" --ignore-scripts --no-audit --no-fund | Out-Null
  } finally { Pop-Location }
}
if (-not (Test-Path $exe)) { throw "kandev runtime missing at $exe" }

# The user's OpenCode binary, resolved before APPDATA is redirected (used by shim\opencode.cmd).
$opencodeExe = Join-Path $env:APPDATA 'npm\node_modules\@opencode\cli\bin\opencode.exe'

# --- clean, allow-listed environment for Kandev and its workers ---
$keep = @('SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'PATH', 'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'DriverData')
foreach ($name in @(Get-ChildItem env: | ForEach-Object Name)) {
  if ($keep -notcontains $name) { Remove-Item "env:$name" -ErrorAction SilentlyContinue }
}
$dirs = @{
  HOME = $workerHome; USERPROFILE = $workerHome
  APPDATA = (Join-Path $workerHome 'AppData\Roaming'); LOCALAPPDATA = (Join-Path $workerHome 'AppData\Local')
  TEMP = (Join-Path $workerHome 'tmp'); TMP = (Join-Path $workerHome 'tmp')
  XDG_CONFIG_HOME = (Join-Path $workerHome '.config'); XDG_DATA_HOME = (Join-Path $workerHome '.local\share')
  XDG_STATE_HOME = (Join-Path $workerHome '.local\state'); XDG_CACHE_HOME = (Join-Path $workerHome '.cache')
  CLAUDE_CONFIG_DIR = (Join-Path $workerHome '.claude'); npm_config_cache = (Join-Path $workerHome 'npm-cache')
}
foreach ($k in $dirs.Keys) { New-Item -ItemType Directory -Force $dirs[$k] | Out-Null; Set-Item "env:$k" $dirs[$k] }
# No user/global git config (credential helpers, signing keys, aliases); KKD commits with explicit -c identity.
$gitCfg = Join-Path $workerHome '.gitconfig'
if (-not (Test-Path $gitCfg)) { "[core]`n`tautocrlf = false`n" | Out-File -Encoding ascii $gitCfg }
$env:GIT_CONFIG_GLOBAL = $gitCfg
$env:GIT_TERMINAL_PROMPT = '0'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:DISABLE_AUTOUPDATER = '1'

# Loopback only: Kandev ships with authentication off and would otherwise listen on 0.0.0.0.
if (-not $BindHost) { $BindHost = '127.{0}.{1}.{2}' -f (Get-Random -Minimum 2 -Maximum 250), (Get-Random -Minimum 1 -Maximum 254), (Get-Random -Minimum 2 -Maximum 254) }
if ($BindHost -notmatch '^127\.\d+\.\d+\.\d+$') { throw "BindHost must be a 127.x.y.z loopback address" }
if ($Port -eq 0) {
  # random free port in the dynamic range, away from the well-known 38500 and the OpenCode worker port
  do { $Port = Get-Random -Minimum 41000 -Maximum 64000 } while (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue)
}
$env:KANDEV_SERVER_HOST = $BindHost
$env:KANDEV_HOME_DIR = $KandevHome
# OpenCode workers ask before edits/commands/MCP calls, so every action goes through KKD's permission broker.
$env:OPENCODE_CONFIG = Join-Path $here 'opencode-worker.json'
$env:KKD_OPENCODE_EXE = $opencodeExe
# OpenCode v2 compatibility shim for Kandev v0.97.0 (see shim\opencode.cmd).
$env:PATH = (Join-Path $here 'shim') + ';' + $env:PATH

$log = Join-Path $KandevHome 'kandev-launcher.log'
$proc = Start-Process -FilePath (Join-Path $pkg 'node_modules\.bin\kandev.cmd') -ArgumentList @('--headless', '--port', "$Port") `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
$proc.Id | Out-File -Encoding ascii $pidFile

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try { $ok = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://${BindHost}:$Port/health").StatusCode -eq 200 } catch { $ok = $false }
  if ($ok) {
    Start-Sleep -Seconds 2 # agentctl opens its ports right after the backend
    Assert-LoopbackOnly $proc.Id
    @{ url = "http://${BindHost}:$Port"; host = $BindHost; port = $Port; pid = $proc.Id; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Out-File -Encoding ascii $endpointFile
    # Only the current user (and SYSTEM) may read the endpoint: it is the capability to reach Kandev.
    & icacls.exe $endpointFile /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(R,W)" 'SYSTEM:(R)' | Out-Null
    Write-Output "Kandev $Version running on http://${BindHost}:$Port (loopback only, random endpoint; home $KandevHome; worker profile $workerHome; pid $($proc.Id))"
    exit 0
  }
}
throw "Kandev did not become healthy; see $log"
