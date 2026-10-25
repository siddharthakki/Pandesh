<#
.SYNOPSIS
    Windows Sandbox guest test for the Pandesh production installer.
    Must stay compatible with Windows PowerShell 5.1 (powershell.exe): no ternary, no ?. / ??, no && / ||.
    Keep this file ASCII-only: 5.1 reads BOM-less files in the ANSI code page.

.DESCRIPTION
    Runs inside Windows Sandbox from the LogonCommand. Installs the real installer, exercises the installed app,
    uninstalls, and writes sandbox-result.json. Every required check must be present and PASS.
#>
param(
    [Parameter(Mandatory=$true)][string]$InstallerPath,
    [Parameter(Mandatory=$true)][string]$ExpectedInstallerSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedChecksPath,
    [Parameter(Mandatory=$true)][string]$ProbePath,
    [Parameter(Mandatory=$true)][string]$ResultsPath,
    [Parameter(Mandatory=$true)][string]$LogsPath
)

$ErrorActionPreference = 'Stop'
$script:checks = New-Object System.Collections.ArrayList
$script:logs = New-Object System.Collections.ArrayList
$script:evidence = @{}
$script:environment = @{}
$CdpPort = 9333

function Add-Log {
    param([string]$Message)
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message
    [void]$script:logs.Add($line)
    Write-Host ('  LOG: ' + $line)
}

function Add-Check {
    param(
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][ValidateSet('PASS','FAIL','SKIP')][string]$Status,
        [string]$Detail = '',
        [string]$Evidence = ''
    )
    [void]$script:checks.Add([PSCustomObject]@{ name = $Name; status = $Status; detail = $Detail; evidence = $Evidence })
    Write-Host ('[' + $Status + '] ' + $Name + ' - ' + $Detail)
    if ($Evidence) { Write-Host ('  Evidence: ' + $Evidence) }
}

function Get-FinalVerdict {
    $expected = (Get-Content -Raw -Path $ExpectedChecksPath | ConvertFrom-Json).requiredChecks
    $problems = New-Object System.Collections.ArrayList
    foreach ($name in $expected) {
        $found = @($script:checks | Where-Object { $_.name -eq $name })
        if ($found.Count -eq 0) { [void]$problems.Add('missing check ' + $name) }
        elseif ($found.Count -gt 1) { [void]$problems.Add('duplicate check ' + $name) }
        elseif ($found[0].status -ne 'PASS') { [void]$problems.Add($name + ' is ' + $found[0].status) }
    }
    foreach ($check in $script:checks) {
        if ($expected -notcontains $check.name) { [void]$problems.Add('unexpected check ' + $check.name) }
    }
    return [PSCustomObject]@{ ok = ($problems.Count -eq 0); problems = @($problems) }
}

function Write-Result {
    $verdict = Get-FinalVerdict
    $result = [ordered]@{
        ok = $verdict.ok
        problems = $verdict.problems
        environment = $script:environment
        checks = @($script:checks)
        evidence = $script:evidence
        logs = @($script:logs)
        screenshots = @()
    }
    $json = $result | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText((Join-Path $ResultsPath 'sandbox-result.json'), $json)
    return $verdict
}

function Stop-ProcessTree {
    param([int]$ProcessId)
    $children = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $ProcessId) -ErrorAction SilentlyContinue)
    foreach ($child in $children) { Stop-ProcessTree -ProcessId ([int]$child.ProcessId) }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Invoke-Probe {
    param([string]$NodeExe, [string[]]$ProbeArguments, [int]$TimeoutSeconds = 300)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    $quoted = @($ProbePath) + $ProbeArguments | ForEach-Object { '"' + $_ + '"' }
    $psi.Arguments = ($quoted -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
        Stop-ProcessTree -ProcessId $proc.Id
        throw ('probe timed out after ' + $TimeoutSeconds + 's: ' + ($ProbeArguments -join ' '))
    }
    $stdout = $stdoutTask.Result.Trim()
    if (-not $stdout) { throw ('probe produced no output (exit ' + $proc.ExitCode + '): ' + $stderrTask.Result) }
    $lastLine = ($stdout -split "`n" | Select-Object -Last 1)
    return ($lastLine | ConvertFrom-Json)
}

# ---------------------------------------------------------------------------------------------- boot evidence
New-Item -ItemType Directory -Force -Path $ResultsPath | Out-Null
New-Item -ItemType Directory -Force -Path $LogsPath | Out-Null
$os = Get-CimInstance Win32_OperatingSystem
$script:environment = [ordered]@{
    windowsCaption = $os.Caption
    windowsVersion = $os.Version
    windowsBuild = $os.BuildNumber
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    powershellEdition = if ($PSVersionTable.PSEdition) { [string]$PSVersionTable.PSEdition } else { 'Desktop' }
    user = $env:USERNAME
    startedAt = (Get-Date).ToString('o')
}
[System.IO.File]::WriteAllText((Join-Path $ResultsPath 'guest-started.json'), ($script:environment | ConvertTo-Json -Depth 4))
Add-Log 'Guest script started'
Add-Check 'SandboxBoot' 'PASS' ('Guest booted: ' + $os.Caption + ' ' + $os.Version + ', Windows PowerShell ' + $PSVersionTable.PSVersion.ToString()) ''

# Ensure Smart App Control / Code Integrity policy is turned off and refreshed
$ciPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
if (-not (Test-Path $ciPath)) { New-Item -Path $ciPath -Force -ErrorAction SilentlyContinue | Out-Null }
Set-ItemProperty -Path $ciPath -Name 'VerifiedAndReputablePolicyState' -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
Set-ItemProperty -Path $ciPath -Name 'UpgradedSystem' -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
& citool.exe --refresh 2>$null

try {
    $activePolicies = & citool.exe --list-policies --json 2>$null | ConvertFrom-Json
    if ($activePolicies -and $activePolicies.Policies) {
        foreach ($p in $activePolicies.Policies) {
            Add-Log ('CI Policy: Name="' + $p.FriendlyName + '" Id=' + $p.PolicyId + ' Enforced=' + $p.IsEnforced + ' System=' + $p.IsSystemPolicy)
        }
    }
} catch {
    Add-Log ('Could not list CI policies: ' + $_.Exception.Message)
}

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Pandesh'
$dataDir = Join-Path $env:LOCALAPPDATA 'KarkeDikha\desktop'
$sentinelPath = Join-Path $dataDir 'sandbox-sentinel.txt'
$sentinelText = 'pandesh-user-data-sentinel ' + [guid]::NewGuid().ToString()
$electronProcess = $null

try {
    # 1. Clean environment: none of the developer tools the product must not depend on.
    $tools = @('ollama', 'node', 'npm', 'python', 'py', 'opencode', 'hermes', 'git')
    $found = @()
    foreach ($tool in $tools) {
        $cmd = Get-Command $tool -ErrorAction SilentlyContinue
        if ($cmd) { $found += ($tool + '=' + $cmd.Source) }
    }
    if ($found.Count -eq 0) { Add-Check 'CleanEnvironment' 'PASS' ('None of ' + ($tools -join ', ') + ' is on PATH') '' }
    else { Add-Check 'CleanEnvironment' 'FAIL' ('Unexpected tools present: ' + ($found -join '; ')) '' }

    # 2. The installer inside the guest is byte-identical to the one the host measured.
    if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
        Add-Check 'InstallerIntegrity' 'FAIL' ('Installer not found at ' + $InstallerPath) ''
        throw 'installer missing in guest'
    }
    $guestHash = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToUpperInvariant()
    $script:evidence.installerSha256 = $guestHash
    if ($guestHash -eq $ExpectedInstallerSha256.ToUpperInvariant()) { Add-Check 'InstallerIntegrity' 'PASS' 'Guest installer hash equals the host hash' $guestHash }
    else { Add-Check 'InstallerIntegrity' 'FAIL' ('Guest hash ' + $guestHash + ' != host hash ' + $ExpectedInstallerSha256) '' ; throw 'installer hash mismatch' }

    # 3. A user-data sentinel exists BEFORE installing, so install/run/uninstall can be shown to preserve it.
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    [System.IO.File]::WriteAllText($sentinelPath, $sentinelText)
    if ((Get-Content -Raw -LiteralPath $sentinelPath) -eq $sentinelText) { Add-Check 'UserDataSentinelSeeded' 'PASS' 'Sentinel written' $sentinelPath }
    else { Add-Check 'UserDataSentinelSeeded' 'FAIL' 'Sentinel could not be written' $sentinelPath }

    # 3.5 A DISPOSABLE UNRELATED PROCESS, started before the installer runs.
    #
    # Its image file name is deliberately 'node.exe' — the same name the Pandesh
    # payload installs — but its path is outside the install directory. The
    # Windows Restart Manager matches candidate applications by FILE NAME, so
    # before the upgrade-safe shutdown landed, installing Pandesh made Windows
    # ask every unrelated node.exe on the machine to shut down. This decoy is
    # the proof that installing and starting Pandesh no longer closes an
    # application Pandesh does not own.
    $decoyDir = 'C:\Sandbox\Decoy'
    $decoyExe = Join-Path $decoyDir 'node.exe'
    $decoyPid = 0
    New-Item -ItemType Directory -Force -Path $decoyDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\timeout.exe') -Destination $decoyExe -Force
    try {
        $decoy = Start-Process -FilePath $decoyExe -ArgumentList '/T', '900', '/NOBREAK' -WindowStyle Hidden -PassThru
        $decoyPid = $decoy.Id
        Start-Sleep -Milliseconds 800
        Add-Log ('Decoy process started: pid ' + $decoyPid + ' (' + $decoyExe + ')')
    } catch {
        Add-Log ('Could not start the decoy process: ' + $_.Exception.Message)
    }
    $script:evidence.decoy = [ordered]@{ pid = $decoyPid; path = $decoyExe }

    # 4. Install, silently, with the real installer.
    Add-Log 'Running installer silently'
    $installLog = Join-Path $LogsPath 'install.log'
    $localInstaller = Join-Path $env:TEMP 'Pandesh-Setup.exe'
    Add-Log ('Staging installer locally to ' + $localInstaller)
    Copy-Item -LiteralPath $InstallerPath -Destination $localInstaller -Force
    Unblock-File -LiteralPath $localInstaller -ErrorAction SilentlyContinue
    Remove-ItemProperty -LiteralPath $localInstaller -Name 'Zone.Identifier' -ErrorAction SilentlyContinue

    # Configure exclusions and disable SmartScreen to prevent container Application Control blocking
    Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue
    Add-MpPreference -ExclusionPath @('C:\Sandbox', $env:TEMP, $installDir, (Split-Path $installDir)) -ErrorAction SilentlyContinue
    Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' -Name 'SmartScreenEnabled' -Value 'Off' -ErrorAction SilentlyContinue
    Set-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppHost' -Name 'SmartScreenEnabled' -Value 'Off' -ErrorAction SilentlyContinue
    Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Name 'EnableSmartScreen' -Value 0 -ErrorAction SilentlyContinue

    $installArgs = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="' + $installDir + '" /LOG="' + $installLog + '"'
    $installProcess = $null
    try {
        $installProcess = Start-Process -FilePath $localInstaller -ArgumentList $installArgs -WorkingDirectory $env:TEMP -Wait -PassThru
    } catch {
        Add-Log ('Start-Process direct failed: ' + $_.Exception.Message + '; trying cmd.exe fallback')
        $cmdArgs = '/c ""' + $localInstaller + '" ' + $installArgs + '"'
        $installProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdArgs -WorkingDirectory $env:TEMP -Wait -PassThru
    }

    if ($installProcess -and $installProcess.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $installDir 'electron\Pandesh.exe'))) {
        Add-Check 'InstallerExecution' 'PASS' 'Installer exited 0' ('install log: ' + $installLog)
    } else {
        $exitCode = if ($installProcess) { [string]$installProcess.ExitCode } else { 'none' }
        Add-Check 'InstallerExecution' 'FAIL' ('Installer exit code ' + $exitCode) ('log exists=' + (Test-Path -LiteralPath $installLog))
        throw 'installer failed'
    }

    # 4.1 The unrelated process must have survived the installation.
    $decoyAliveAfterInstall = $false
    if ($decoyPid -gt 0) {
        $decoyAliveAfterInstall = [bool](Get-Process -Id $decoyPid -ErrorAction SilentlyContinue)
    }
    if ($decoyPid -gt 0 -and $decoyAliveAfterInstall) {
        Add-Check 'UnrelatedProcessSurvivesInstall' 'PASS' ('The unrelated node.exe (pid ' + $decoyPid + ') is still running after the installation') ('pid=' + $decoyPid + ' path=' + $decoyExe)
    } else {
        Add-Check 'UnrelatedProcessSurvivesInstall' 'FAIL' ('The unrelated node.exe (pid ' + $decoyPid + ') did not survive the installation') ('pid=' + $decoyPid + ' path=' + $decoyExe)
    }

    # Unblock all installed files to avoid MOTW execution friction
    Get-ChildItem -LiteralPath $installDir -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

    # 5. Installed layout.
    $required = @(
        'electron\Pandesh.exe', 'app\package.json', 'app\out\main.js', 'app\renderer\index.html', 'runtime\core.js', 'runtime\node.exe',
        'build-fingerprint.json', 'build-identity.json', 'models\whisper-base-en', 'runtime-assets\node_modules\@xenova\transformers',
        'runtime\node_modules\@earendil-works\pi-agent-core', 'runtime\node_modules\@earendil-works\pi-ai',
        'runtime\node_modules\typebox', 'runtime\node_modules\partial-json', 'unins000.exe'
    )
    $missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $installDir $_)) })
    if ($missing.Count -eq 0) { Add-Check 'InstallPaths' 'PASS' ('All ' + $required.Count + ' required paths exist under ' + $installDir) '' }
    else { Add-Check 'InstallPaths' 'FAIL' ('Missing: ' + ($missing -join ', ')) ''; throw 'install layout incomplete' }
    $script:evidence.releaseManifest = (Get-Content -Raw -LiteralPath (Join-Path $installDir 'build-fingerprint.json') | ConvertFrom-Json)

    # 6. Shortcuts, resolved to their real targets.
    $shell = New-Object -ComObject WScript.Shell
    $shortcutPaths = @(
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Pandesh\Pandesh.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pandesh.lnk')
    )
    $shortcutProblems = @()
    $shortcutEvidence = @()
    foreach ($lnk in $shortcutPaths) {
        if (-not (Test-Path -LiteralPath $lnk)) { $shortcutProblems += ('missing ' + $lnk); continue }
        $target = $shell.CreateShortcut($lnk).TargetPath
        $shortcutEvidence += ($lnk + ' -> ' + $target)
        if ($target -ne (Join-Path $installDir 'electron\Pandesh.exe')) { $shortcutProblems += ('wrong target ' + $target) }
    }
    if ($shortcutProblems.Count -eq 0) { Add-Check 'Shortcuts' 'PASS' 'Start Menu and Desktop shortcuts point at the installed Pandesh.exe' ($shortcutEvidence -join ' | ') }
    else { Add-Check 'Shortcuts' 'FAIL' ($shortcutProblems -join '; ') ($shortcutEvidence -join ' | ') }

    # Everything below uses the Node that shipped in the installed runtime; the guest has no other.
    $nodeExe = Join-Path $installDir 'runtime\node.exe'
    $runtimeDir = Join-Path $installDir 'runtime'
    $script:environment.bundledNode = (& $nodeExe --version)

    # 7. Prohibited packaged files and real credential material (provider-specific formats, not keywords).
    $scan = Invoke-Probe -NodeExe $nodeExe -ProbeArguments @('scan', $installDir) -TimeoutSeconds 600
    $script:evidence.scan = [ordered]@{ filesScanned = $scan.filesScanned; bytesScanned = $scan.bytesScanned }
    if (@($scan.prohibited).Count -eq 0) { Add-Check 'ProhibitedPackagedFiles' 'PASS' ('No prohibited files in ' + $scan.filesScanned + ' scanned text files') '' }
    else { Add-Check 'ProhibitedPackagedFiles' 'FAIL' ('Prohibited packaged files: ' + (@($scan.prohibited) -join '; ')) '' }
    if (@($scan.credentials).Count -eq 0) { Add-Check 'CredentialMaterial' 'PASS' 'No credential material matched' ('files=' + $scan.filesScanned + ' bytes=' + $scan.bytesScanned) }
    else {
        $hits = @($scan.credentials | ForEach-Object { $_.kind + ' in ' + $_.file + ' @' + $_.offset })
        Add-Check 'CredentialMaterial' 'FAIL' ('Credential-shaped material found: ' + ($hits -join '; ')) ''
    }

    # 8. Bundled Pi dependencies are dynamically imported with the bundled Node.
    $pi = Invoke-Probe -NodeExe $nodeExe -ProbeArguments @('pi-import', $runtimeDir) -TimeoutSeconds 120
    $script:evidence.piImport = $pi
    $piSummary = @($pi.results | ForEach-Object { $_.name + '@' + $_.version + ' exports=' + $_.keyCount }) -join '; '
    if ($pi.ok) { Add-Check 'PiDependencyImport' 'PASS' ('Dynamic import succeeded with bundled Node ' + $pi.node) $piSummary }
    else { Add-Check 'PiDependencyImport' 'FAIL' ('Dynamic import failed: ' + (ConvertTo-Json -InputObject $pi.results -Depth 4 -Compress)) $piSummary }

    # 9. Launch the installed app with no Ollama present, then prove readiness through the real interfaces.
    $env:KARKEDIKHA_DESKTOP_DATA_DIR = $dataDir
    $env:KARKEDIKHA_DESKTOP_CDP_PORT = [string]$CdpPort
    $env:KARKEDIKHA_MODEL_ROUTING_POLICY = 'local-only'
    $env:KARKEDIKHA_DESKTOP_HOST_LOG = (Join-Path $LogsPath 'pandesh-host.log')
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $pandeshExe = Join-Path $installDir 'electron\Pandesh.exe'
    Unblock-File -LiteralPath $pandeshExe -ErrorAction SilentlyContinue
    $appPath = Join-Path $installDir 'app'
    $electronArgs = '--remote-debugging-port=' + $CdpPort + ' "' + $appPath + '"'
    $electronProcess = Start-Process -FilePath $pandeshExe -ArgumentList $electronArgs -WorkingDirectory $installDir -PassThru
    Add-Log ('Launched Pandesh.exe pid ' + $electronProcess.Id)
    $runtime = Invoke-Probe -NodeExe $nodeExe -ProbeArguments @('runtime', $dataDir, [string]$CdpPort, '180') -TimeoutSeconds 300
    $script:evidence.runtime = $runtime

    if ($runtime.health -and $runtime.health.httpStatus -eq 200 -and $runtime.health.body.status -eq 'ok') {
        Add-Check 'CoreHealth' 'PASS' ('GET /v1/health -> 200 {"status":"ok"} on port ' + ($runtime.steps | Where-Object { $_.name -eq 'core_record' } | Select-Object -First 1).detail.port) ''
    } else { Add-Check 'CoreHealth' 'FAIL' ('Core health not proven: ' + $runtime.error) '' }

    if ($runtime.coreInfo -and $runtime.coreInfo.httpStatus -eq 200) { Add-Check 'CoreAuthenticatedApi' 'PASS' 'GET /v1/core/info with the stored token -> 200' (ConvertTo-Json -InputObject $runtime.coreInfo.body -Depth 4 -Compress) }
    else { Add-Check 'CoreAuthenticatedApi' 'FAIL' ('Authenticated Core API not proven: ' + $runtime.error) '' }

    if ($runtime.snapshot -and $runtime.snapshot.coreState -eq 'connected') { Add-Check 'DesktopCoreConnected' 'PASS' 'Desktop host reports coreState=connected' (ConvertTo-Json -InputObject $runtime.snapshot -Depth 4 -Compress) }
    else { Add-Check 'DesktopCoreConnected' 'FAIL' ('Desktop host never reported connected: ' + $runtime.error) '' }

    # 10. Missing Ollama / model is reported truthfully: no models, UI says so, submit is refused with a clear reason.
    $modelCount = 0
    if ($runtime.snapshot -and $runtime.snapshot.installedModels) { $modelCount = @($runtime.snapshot.installedModels).Count }
    $submitMessage = ''
    $submitAccepted = $true
    if ($runtime.submit) { $submitAccepted = [bool]$runtime.submit.accepted; $submitMessage = [string]$runtime.submit.message }
    $badge = [string]$runtime.modelsBadge
    $honest = ($modelCount -eq 0) -and ($badge -match 'No models found|Selected model missing') -and (-not $submitAccepted) -and ($submitMessage -match 'ollama|model')
    $missingEvidence = 'models=' + $modelCount + '; badge="' + $badge + '"; submitAccepted=' + $submitAccepted + '; submitMessage="' + $submitMessage + '"'
    if ($honest) { Add-Check 'MissingOllamaHandling' 'PASS' 'Zero models reported, badge says so, and a submit is refused with an Ollama/model reason' $missingEvidence }
    else { Add-Check 'MissingOllamaHandling' 'FAIL' 'Missing Ollama/model was not reported truthfully' $missingEvidence }

    # 10.1 The unrelated process must still be running while Pandesh is up.
    $decoyAliveWhileRunning = $false
    if ($decoyPid -gt 0) {
        $decoyAliveWhileRunning = [bool](Get-Process -Id $decoyPid -ErrorAction SilentlyContinue)
    }
    if ($decoyPid -gt 0 -and $decoyAliveWhileRunning) {
        Add-Check 'UnrelatedProcessSurvivesAppStart' 'PASS' ('The unrelated node.exe (pid ' + $decoyPid + ') is still running while Pandesh is up') ('pid=' + $decoyPid + ' path=' + $decoyExe)
    } else {
        Add-Check 'UnrelatedProcessSurvivesAppStart' 'FAIL' ('The unrelated node.exe (pid ' + $decoyPid + ') did not survive Pandesh starting') ('pid=' + $decoyPid + ' path=' + $decoyExe)
    }

    # 10.2 Deliberate unauthorized process termination probes:
    # Attempt unauthorized termination through system_kill_process, port_stop_service,
    # port_cleanup_orphans, unattended agent execution, and shell bypass.
    # Every attempt must be rejected and the target process ($decoyPid) must remain alive.
    $killProbes = Invoke-Probe -NodeExe $nodeExe -ProbeArguments @('unauthorized-kills', $dataDir, [string]$decoyPid) -TimeoutSeconds 120
    $script:evidence.unauthorizedKillProbes = $killProbes

    if ($killProbes.probes -and $killProbes.probes.unauthorizedKillProcess -and $killProbes.probes.unauthorizedKillProcess.pass) {
        Add-Check 'UnauthorizedKillProcessRejected' 'PASS' 'system_kill_process on unowned PID rejected/held at approval; target remained alive' ('targetPid=' + $decoyPid)
    } else {
        Add-Check 'UnauthorizedKillProcessRejected' 'FAIL' 'system_kill_process was not rejected cleanly or target died' (ConvertTo-Json -InputObject $killProbes.probes.unauthorizedKillProcess -Compress)
    }

    if ($killProbes.probes -and $killProbes.probes.unauthorizedPortControl -and $killProbes.probes.unauthorizedPortControl.pass) {
        Add-Check 'UnauthorizedPortControlRejected' 'PASS' 'port_stop_service on unowned service refused by ownership boundary; target remained alive' ('targetPid=' + $decoyPid)
    } else {
        Add-Check 'UnauthorizedPortControlRejected' 'FAIL' 'port_stop_service did not reject unowned target cleanly' (ConvertTo-Json -InputObject $killProbes.probes.unauthorizedPortControl -Compress)
    }

    if ($killProbes.probes -and $killProbes.probes.unauthorizedPortCleanup -and $killProbes.probes.unauthorizedPortCleanup.pass) {
        Add-Check 'UnauthorizedPortCleanupRejected' 'PASS' 'port_cleanup_orphans denied unattended and refused unowned process; target remained alive' ('targetPid=' + $decoyPid)
    } else {
        Add-Check 'UnauthorizedPortCleanupRejected' 'FAIL' 'port_cleanup_orphans did not reject unowned target cleanly' (ConvertTo-Json -InputObject $killProbes.probes.unauthorizedPortCleanup -Compress)
    }

    if ($killProbes.probes -and $killProbes.probes.unattendedMachineControl -and $killProbes.probes.unattendedMachineControl.pass) {
        Add-Check 'UnattendedMachineControlRejected' 'PASS' 'Unattended agent execution denied closed for machine control tools; target remained alive' ('targetPid=' + $decoyPid)
    } else {
        Add-Check 'UnattendedMachineControlRejected' 'FAIL' 'Unattended machine control was not denied closed' (ConvertTo-Json -InputObject $killProbes.probes.unattendedMachineControl -Compress)
    }

    if ($killProbes.probes -and $killProbes.probes.unauthorizedShellBypass -and $killProbes.probes.unauthorizedShellBypass.pass) {
        Add-Check 'UnauthorizedShellBypassRejected' 'PASS' 'Consequential shell kill command blocked at approval gate; target remained alive' ('targetPid=' + $decoyPid)
    } else {
        Add-Check 'UnauthorizedShellBypassRejected' 'FAIL' 'Shell bypass was not blocked by approval gate' (ConvertTo-Json -InputObject $killProbes.probes.unauthorizedShellBypass -Compress)
    }


    # 11. The installed build identity must agree with the installed manifest
    # and with the app manifest, and must name a real build number.
    $identityPath = Join-Path $installDir 'build-identity.json'
    $identity = $null
    $identityProblems = @()
    if (-not (Test-Path -LiteralPath $identityPath)) {
        $identityProblems += 'build-identity.json is missing from the install'
    } else {
        $identity = (Get-Content -Raw -LiteralPath $identityPath | ConvertFrom-Json)
        $appManifest = (Get-Content -Raw -LiteralPath (Join-Path $installDir 'app\package.json') | ConvertFrom-Json)
        if ([string]$identity.version -ne [string]$appManifest.version) { $identityProblems += ('identity version ' + $identity.version + ' != app manifest version ' + $appManifest.version) }
        if ($script:evidence.releaseManifest -and $script:evidence.releaseManifest.buildIdentity) {
            if ([string]$script:evidence.releaseManifest.buildIdentity.version -ne [string]$identity.version) { $identityProblems += 'release manifest identity version differs from the installed identity' }
        } else {
            $identityProblems += 'the release manifest does not carry a build identity'
        }
        if (-not $identity.buildNumber -or [int]$identity.buildNumber -le 0) { $identityProblems += 'the build number is missing or not positive' }
        if ([string]$identity.releaseChannel -notin @('dev', 'alpha', 'beta', 'stable')) { $identityProblems += ('unknown release channel ' + $identity.releaseChannel) }
        if ([string]::IsNullOrWhiteSpace([string]$identity.commit)) { $identityProblems += 'the commit SHA is missing' }
    }
    if ($identityProblems.Count -eq 0) {
        Add-Check 'BuildIdentityConsistent' 'PASS' ('Installed build identity: v' + $identity.version + ' b' + $identity.buildNumber + ' (' + $identity.releaseChannel + ') commit ' + $identity.commit) (ConvertTo-Json -InputObject $identity -Compress)
    } else {
        Add-Check 'BuildIdentityConsistent' 'FAIL' ($identityProblems -join '; ') ''
    }
} catch {
    Add-Log ('FATAL: ' + $_.Exception.Message)
    Add-Log ([string]$_.ScriptStackTrace)
    try {
        $ciEvents = Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-CodeIntegrity/Operational'} -MaxEvents 5 -ErrorAction SilentlyContinue
        foreach ($e in $ciEvents) { Add-Log ('CI Event ' + $e.Id + ': ' + $e.Message) }
    } catch {}
    try {
        $alEvents = Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-AppLocker/EXE and DLL'} -MaxEvents 5 -ErrorAction SilentlyContinue
        foreach ($e in $alEvents) { Add-Log ('AppLocker Event ' + $e.Id + ': ' + $e.Message) }
    } catch {}
    Add-Check 'TestHarness' 'FAIL' ('Guest harness stopped: ' + $_.Exception.Message) ([string]$_)
} finally {
    if ($electronProcess) { Stop-ProcessTree -ProcessId $electronProcess.Id; Start-Sleep -Seconds 3 }
}

# The unrelated process must survive Pandesh being closed as well.
try {
    $decoyAliveAfterShutdown = $false
    if ($decoyPid -gt 0) {
        $decoyAliveAfterShutdown = [bool](Get-Process -Id $decoyPid -ErrorAction SilentlyContinue)
    }
    if ($decoyPid -gt 0 -and $decoyAliveAfterShutdown) {
        Add-Check 'UnrelatedProcessSurvivesShutdown' 'PASS' ('The unrelated node.exe (pid ' + $decoyPid + ') is still running after Pandesh was closed') ('pid=' + $decoyPid + ' path=' + $decoyExe)
    } else {
        Add-Check 'UnrelatedProcessSurvivesShutdown' 'FAIL' ('The unrelated node.exe (pid ' + $decoyPid + ') did not survive Pandesh being closed') ('pid=' + $decoyPid + ' path=' + $decoyExe)
    }
} catch {
    Add-Check 'UnrelatedProcessSurvivesShutdown' 'FAIL' ('Could not check the decoy process: ' + $_.Exception.Message) ''
}

# The remaining steps run even if an earlier one failed, so the report is complete and honest.
try {
    # 11. The app has run against this data directory; the sentinel must be untouched.
    if ((Test-Path -LiteralPath $sentinelPath) -and ((Get-Content -Raw -LiteralPath $sentinelPath) -eq $sentinelText)) { Add-Check 'UserDataAfterRun' 'PASS' 'Sentinel intact after install and app run' $sentinelPath }
    else { Add-Check 'UserDataAfterRun' 'FAIL' 'Sentinel missing or modified after install and app run' $sentinelPath }

    # 12. Uninstall. The Inno uninstaller re-launches itself from a temp copy, so wait on the result, not the process.
    $uninstaller = Join-Path $installDir 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        Unblock-File -LiteralPath $uninstaller -ErrorAction SilentlyContinue
        $uninstallArgs = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCLOSEAPPLICATIONS'
        Start-Process -FilePath $uninstaller -ArgumentList $uninstallArgs -Wait | Out-Null
        $deadline = (Get-Date).AddSeconds(90)
        while ((Test-Path -LiteralPath (Join-Path $installDir 'electron\Pandesh.exe')) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 1 }
        Start-Sleep -Seconds 3
        $left = @()
        if (Test-Path -LiteralPath $installDir) { $left = @(Get-ChildItem -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -First 10 | ForEach-Object { $_.FullName }) }
        $shortcutsLeft = @($shortcutPaths | Where-Object { Test-Path -LiteralPath $_ })
        if ((-not (Test-Path -LiteralPath (Join-Path $installDir 'electron\Pandesh.exe'))) -and ($left.Count -eq 0) -and ($shortcutsLeft.Count -eq 0)) {
            Add-Check 'UninstallRemovesProgram' 'PASS' 'Program files and shortcuts were removed' ''
        } else {
            Add-Check 'UninstallRemovesProgram' 'FAIL' ('Remaining after uninstall: ' + (($left + $shortcutsLeft) -join '; ')) ''
        }
    } else {
        Add-Check 'UninstallRemovesProgram' 'FAIL' 'Uninstaller not found' ''
    }

    # 13. User data survives uninstall.
    if ((Test-Path -LiteralPath $sentinelPath) -and ((Get-Content -Raw -LiteralPath $sentinelPath) -eq $sentinelText)) { Add-Check 'UserDataAfterUninstall' 'PASS' 'Sentinel intact after uninstall' $sentinelPath }
    else { Add-Check 'UserDataAfterUninstall' 'FAIL' 'Sentinel missing or modified after uninstall' $sentinelPath }

    # 14. The sandbox really is network-isolated, so nothing above could have been satisfied from the internet.
    $reachable = $false
    try { $null = Invoke-WebRequest -Uri 'http://example.com/' -TimeoutSec 6 -UseBasicParsing; $reachable = $true } catch { $reachable = $false }
    if (-not $reachable) { Add-Check 'NetworkIsolation' 'PASS' 'No outbound HTTP from the guest' '' }
    else { Add-Check 'NetworkIsolation' 'FAIL' 'The guest reached the internet' '' }
} catch {
    Add-Log ('FATAL (post-run): ' + $_.Exception.Message)
    Add-Check 'TestHarness' 'FAIL' ('Guest harness stopped after the run: ' + $_.Exception.Message) ([string]$_)
}

$script:environment.finishedAt = (Get-Date).ToString('o')
$verdict = Write-Result
Add-Log ('Guest verdict: ' + $(if ($verdict.ok) { 'PASS' } else { 'FAIL' }))
[System.IO.File]::WriteAllText((Join-Path $ResultsPath 'guest-done.flag'), (Get-Date).ToString('o'))
Start-Sleep -Seconds 2
& shutdown.exe /s /t 5 /f
if ($verdict.ok) { exit 0 } else { exit 1 }