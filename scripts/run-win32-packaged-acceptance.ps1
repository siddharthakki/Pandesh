<#
.SYNOPSIS
  Runs the packaged Windows acceptance suite against an already-built VSIX,
  using genuine Windows node.exe and Windows Code.exe from the existing
  self-hosted Linux (WSL) CI runner. Required deterministic activation and
  lifecycle scenarios gate CI. Real-model warmup, restart, and package-
  provenance dogfood are independently recorded diagnostics only.

.DESCRIPTION
  Invoked from the Linux self-hosted CI runner via PowerShell interop
  (Windows powershell.exe reached through /mnt/c), the same pattern
  scripts/package-win32-vsix.ps1 and scripts/live-ollama-smoke.ps1 already
  use. This script never runs git and never touches the WSL checkout
  directly (Windows git refuses to operate over a \\wsl.localhost\...\ UNC
  path). The caller instead produces a `git archive` snapshot of the exact
  commit on the Linux side (where that checkout's git already trusts it)
  and passes it in -SourceZip; everything here runs against a fresh copy of
  that snapshot under a Windows %TEMP% staging directory, using Windows
  npm/node exclusively (never the Linux runner's node_modules).

  The supplied VSIX (-VsixPath) is never rebuilt and is installed exactly as
  given, into isolated per-scenario Windows user-data/extensions/global-data/
  workspace directories the packaged acceptance harnesses already create.

.PARAMETER VsixPath
  Windows-visible path to the exact, already-verified VSIX to install.

.PARAMETER SourceZip
  Windows-visible path to a `git archive --format=zip` snapshot of the exact
  commit containing scripts/acceptance/* and package.json (produced and
  verified by the caller).

.PARAMETER HeadSha
  The exact commit SourceZip was archived from. Recorded in evidence only.

.PARAMETER OutDir
  Windows-visible path (outside the repo/checkout) to receive evidence:
  logs, screenshots, DOM snapshots, and structured JSON evidence.

.PARAMETER RunId
  CI workflow run id, used only to namespace the staging directory.

.PARAMETER Scenarios
  Comma-separated list of run-m32-packaged-dogfood.mjs scenario names to run
  after activation_registration. Defaults to the deterministic M35 and M36
  scenarios plus the real-model restart scenario. The live package-provenance
  diagnostic is invoked separately and reported without becoming a gate.
  (both self-report NOT_ATTEMPTED, exit code 2, if no local Ollama with the
  required models is reachable — treated as a skip here, not a failure).
#>
param(
  [Parameter(Mandatory = $true)][string]$VsixPath,
  [Parameter(Mandatory = $true)][string]$SourceZip,
  [Parameter(Mandatory = $true)][string]$HeadSha,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$RunId,
  [string]$Scenarios = 'm35-inline-approval,m35-package-provenance-gate,m36-attachment-restart,m36-document-audio-restart,m36-governed-research-restart,m36-combined-workbench,m39-memory-knowledge-restart,restart'
)

$ErrorActionPreference = 'Stop'

function Assert-LastExitCode([string]$Step) {
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed with exit code ${LASTEXITCODE}: $Step"
  }
}

function Write-JsonEvidence([string]$Path, $Object) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  # .NET's UTF8Encoding($false) avoids PowerShell 5.1's BOM-emitting utf8.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $writer = New-Object System.IO.StreamWriter($temporary, $false, $utf8NoBom)
  try {
    $writer.Write(($Object | ConvertTo-Json -Depth 20))
    $writer.Write("`n")
    $writer.Flush()
    $writer.BaseStream.Flush($true)
  }
  finally {
    $writer.Dispose()
  }
  if (Test-Path -LiteralPath $Path) {
    [System.IO.File]::Replace($temporary, $Path, $null)
  } else {
    [System.IO.File]::Move($temporary, $Path)
  }
}

function Get-AdvisoryCdpReadiness([string[]]$LogPaths) {
  foreach ($logPath in $LogPaths) {
    if (-not (Test-Path -LiteralPath $logPath)) { continue }
    $content = Get-Content -LiteralPath $logPath -Raw
    if ($content -match '(?is)(cdp.*?(timed out|timeout)|(timed out|timeout).*?cdp)') {
      return [ordered]@{ status = 'timed_out'; logPath = $logPath }
    }
  }
  return [ordered]@{ status = 'not_observed'; logPaths = $LogPaths }
}

# --- Preflight: Windows node/npm and the supplied VSIX must exist. Never
# fall back to any other node/npm or to rebuilding the VSIX. ---
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'Windows node.exe was not found on PATH.' }
if (-not $npmCmd) { throw 'Windows npm.cmd was not found on PATH.' }
if (-not (Test-Path -LiteralPath $VsixPath -PathType Leaf)) { throw "Supplied VSIX not found: $VsixPath" }
if (-not (Test-Path -LiteralPath $SourceZip -PathType Leaf)) { throw "Source snapshot not found: $SourceZip" }

$platform = (& node.exe -p "process.platform").Trim()
Assert-LastExitCode 'node.exe -p process.platform'
$arch = (& node.exe -p "process.arch").Trim()
Assert-LastExitCode 'node.exe -p process.arch'
if ($platform -ne 'win32' -or $arch -ne 'x64') {
  throw "Windows packaged acceptance requires platform=win32 arch=x64, found platform=$platform arch=$arch. Refusing to run."
}

$vsixHasher = Get-FileHash -LiteralPath $VsixPath -Algorithm SHA256
$vsixBytes = (Get-Item -LiteralPath $VsixPath).Length

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$preflight = [ordered]@{
  nodeExecutable = $nodeCmd.Source
  npmExecutable  = $npmCmd.Source
  platform       = $platform
  arch           = $arch
  nodeVersion    = (& node.exe --version).Trim()
  npmVersion     = (& npm.cmd --version).Trim()
  headSha        = $HeadSha
  runId          = $RunId
  vsixPath       = $VsixPath
  vsixBytes      = $vsixBytes
  vsixSha256     = $vsixHasher.Hash.ToLowerInvariant()
  scenarios      = $Scenarios
}
Write-Output "Windows packaged acceptance preflight: $($preflight | ConvertTo-Json -Compress)"
Write-JsonEvidence (Join-Path $OutDir 'windows-packaged-acceptance-preflight.json') $preflight

$stageId = "oa-m35-win-acceptance-$RunId-$([guid]::NewGuid().ToString('N'))"
$stage = Join-Path $env:TEMP $stageId
New-Item -ItemType Directory -Path $stage | Out-Null
$overallStatus = 'unknown'
$activationExit = $null
$mandatoryScenariosExit = $null
$m36Exit = $null
$m36Pass2Exit = $null
$m36ResearchExit = $null
$m36CombinedExit = $null
$realModelWarmupExit = $null
$realModelWarmupEvidence = $null
$realModelRestartExit = $null
$realModelRestartLog = $null
$liveDiagnosticLog = $null
$liveDiagnosticExit = $null

try {
  # VS Code's own extension installer (Electron/Node fs.open, via yauzl)
  # refuses to read a VSIX from a `\\wsl.localhost\...` UNC path
  # (ERR_UNC_HOST_NOT_ALLOWED) even though PowerShell cmdlets and plain file
  # copies have no such restriction. Copy the supplied VSIX into the local
  # %TEMP% stage first (hashing the ORIGINAL supplied file for provenance,
  # same as scripts/package-win32-vsix.ps1 already does for source input)
  # and install from that local copy everywhere below.
  $localVsixPath = Join-Path $stage (Split-Path -Leaf $VsixPath)
  Copy-Item -LiteralPath $VsixPath -Destination $localVsixPath -Force
  $localVsixHash = (Get-FileHash -LiteralPath $localVsixPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($localVsixHash -ne $vsixHasher.Hash.ToLowerInvariant()) {
    throw "Local copy of the supplied VSIX does not match its original hash (original=$($vsixHasher.Hash), copy=$localVsixHash). Refusing to install a possibly-corrupted copy."
  }

  $srcDir = Join-Path $stage 'src'
  Expand-Archive -LiteralPath $SourceZip -DestinationPath $srcDir

  # This staging checkout is a `git archive` snapshot, not a real clone — it
  # has no `.git` directory, so the acceptance harness's own `git rev-parse
  # HEAD` fallback for evidence provenance would resolve to nothing here.
  # Supply the real values explicitly so every evidence.json this run writes
  # (including the dedicated m36-attachment-restart one) records the exact
  # head SHA and CI run id, not "unknown".
  $env:KARKEDIKHA_ACCEPTANCE_HEAD_SHA = $HeadSha
  $env:GITHUB_RUN_ID = $RunId

  Push-Location $srcDir
  try {
    if (-not (Test-Path (Join-Path $srcDir 'node_modules'))) {
      & npm.cmd ci
      Assert-LastExitCode 'npm.cmd ci'
    }

    # Deliberately no `2>&1` around these native node.exe invocations: under
    # PowerShell 5.1 with $ErrorActionPreference = 'Stop', merging a native
    # command's stderr wraps every line (even a harmless tool warning, e.g.
    # vsce's "LICENSE not found") in a terminating NativeCommandError and
    # aborts the whole script even though the process exits 0. stdout is
    # still captured below via Tee-Object; stderr passes through to the
    # console, which the CI step's own outer `2>&1 | tee` already captures.
    $activationLog = Join-Path $OutDir 'activation-registration.log'
    Write-Output "Running activation_registration against the exact supplied VSIX..."
    & node.exe scripts/acceptance/run-packaged-acceptance.mjs --vsix $localVsixPath --scenario activation_registration |
      Tee-Object -FilePath $activationLog
    $activationExit = $LASTEXITCODE
    Write-Output "activation_registration exit code: $activationExit"

    if ($activationExit -eq 0) {
      # A tags response proves only that weights are installed. Record a
      # bounded live-model load diagnostic separately, then proceed regardless
      # into the deterministic scenarios that do not require a real model.
      $realModelWarmupLog = Join-Path $OutDir 'real-model-warmup.log'
      $realModelWarmupEvidencePath = Join-Path $OutDir 'real-model-warmup.json'
      Write-Output 'Running advisory real-model warmup diagnostic...'
      & node.exe scripts/acceptance/run-real-model-warmup.mjs --evidence $realModelWarmupEvidencePath |
        Tee-Object -FilePath $realModelWarmupLog
      $realModelWarmupExit = $LASTEXITCODE
      if (Test-Path -LiteralPath $realModelWarmupEvidencePath) {
        $realModelWarmupEvidence = Get-Content -LiteralPath $realModelWarmupEvidencePath -Raw | ConvertFrom-Json
      } else {
        $realModelWarmupEvidence = [ordered]@{ status = 'runner_failed_without_evidence'; exitCode = $realModelWarmupExit; evidencePath = $realModelWarmupEvidencePath }
      }
      $realModelWarmupEvidence | Add-Member -NotePropertyName logPath -NotePropertyValue $realModelWarmupLog -Force
      Write-Output "real-model warmup exit code (advisory): $realModelWarmupExit"

      # m36-attachment-restart runs in its OWN invocation, before the legacy
      # M35 bundle: the packaged dogfood runner aborts the whole process on
      # its first scenario failure, so a pre-existing flake earlier in the
      # M35 bundle (e.g. m35-inline-approval) would otherwise silently
      # prevent m36-attachment-restart from ever executing in CI at all —
      # this scenario's own CI result must never depend on that.
      $m36Log = Join-Path $OutDir 'm36-attachment-restart.log'
      Write-Output "Running m36-attachment-restart against the exact supplied VSIX..."
      & node.exe scripts/acceptance/run-m32-packaged-dogfood.mjs --vsix $localVsixPath --only=m36-attachment-restart |
        Tee-Object -FilePath $m36Log
      $m36Exit = $LASTEXITCODE
      Write-Output "m36-attachment-restart exit code: $m36Exit"

      # Same isolation rationale as m36-attachment-restart above: its own
      # invocation, so a legacy-bundle flake can never silently prevent this
      # M36 pass-2 mandatory gate from running or being reported.
      $m36Pass2Log = Join-Path $OutDir 'm36-document-audio-restart.log'
      Write-Output "Running m36-document-audio-restart against the exact supplied VSIX..."
      & node.exe scripts/acceptance/run-m32-packaged-dogfood.mjs --vsix $localVsixPath --only=m36-document-audio-restart |
        Tee-Object -FilePath $m36Pass2Log
      $m36Pass2Exit = $LASTEXITCODE
      Write-Output "m36-document-audio-restart exit code: $m36Pass2Exit"

      $m36ResearchLog = Join-Path $OutDir 'm36-governed-research-restart.log'
      Write-Output "Running m36-governed-research-restart against the exact supplied VSIX..."
      & node.exe scripts/acceptance/run-m32-packaged-dogfood.mjs --vsix $localVsixPath --only=m36-governed-research-restart |
        Tee-Object -FilePath $m36ResearchLog
      $m36ResearchExit = $LASTEXITCODE
      Write-Output "m36-governed-research-restart exit code: $m36ResearchExit"

      # `restart` is real-model dependent. It must not share an invocation
      # with M35's deterministic gates: otherwise a live-model warmup or CDP
      # issue prevents those required gates from being attempted and makes an
      # advisory condition look like packaged acceptance failure.
      $mandatoryScenarios = ($Scenarios -split ',' | Where-Object { $_ -ne 'm36-attachment-restart' -and $_ -ne 'm36-document-audio-restart' -and $_ -ne 'm36-governed-research-restart' -and $_ -ne 'm36-combined-workbench' -and $_ -ne 'm39-memory-knowledge-restart' -and $_ -ne 'restart' }) -join ','
      $mandatoryScenariosLog = Join-Path $OutDir 'mandatory-m35-scenarios.log'
      if ($mandatoryScenarios) {
        Write-Output "Running required packaged scenarios ($mandatoryScenarios) against the exact supplied VSIX..."
        & node.exe scripts/acceptance/run-m32-packaged-dogfood.mjs --vsix $localVsixPath --only=$mandatoryScenarios |
          Tee-Object -FilePath $mandatoryScenariosLog
        $mandatoryScenariosExit = $LASTEXITCODE
      } else {
        $mandatoryScenariosExit = 0
        Set-Content -LiteralPath $mandatoryScenariosLog -Value 'No required legacy scenarios were selected.' -Encoding utf8
      }
      Write-Output "required m32-packaged-dogfood ($mandatoryScenarios) exit code: $mandatoryScenariosExit"

      $m36CombinedLog = Join-Path $OutDir 'm36-combined-workbench.log'
      Write-Output "Running m36-combined-workbench against the exact supplied VSIX..."
      & node.exe scripts/acceptance/run-m32-packaged-dogfood.mjs --vsix $localVsixPath --only=m36-combined-workbench |
        Tee-Object -FilePath $m36CombinedLog
      $m36CombinedExit = $LASTEXITCODE
      Write-Output "m36-combined-workbench exit code: $m36CombinedExit"

      # M39 mandatory exit gate. Own invocation, same isolation rationale as
      # every M36 scenario above: an unrelated earlier flake must never be
      # able to prevent this gate from running or being reported.
      $m39Log = Join-Path $OutDir 'm39-memory-knowledge-restart.log'
      Write-Output "Running m39-memory-knowledge-restart against the exact supplied VSIX..."
      & node.exe scripts/acceptance/run-m32-packaged-dogfood.mjs --vsix $localVsixPath --only=m39-memory-knowledge-restart |
        Tee-Object -FilePath $m39Log
      $m39Exit = $LASTEXITCODE
      Write-Output "m39-memory-knowledge-restart exit code: $m39Exit"

      # Keep live real-model scenarios out of the required bundle. They retain
      # their own exit codes/logs/evidence and skip the duplicate in-run
      # warmup because the independently timed diagnostic above owns it.
      $priorWarmupSkip = $env:KARKEDIKHA_SKIP_REAL_MODEL_WARMUP
      $env:KARKEDIKHA_SKIP_REAL_MODEL_WARMUP = '1'
      try {
        if (($Scenarios -split ',') -contains 'restart') {
          $realModelRestartLog = Join-Path $OutDir 'real-model-restart-diagnostic.log'
          Write-Output 'Running advisory real-model restart diagnostic against the exact supplied VSIX...'
          & node.exe scripts/acceptance/run-m32-packaged-dogfood.mjs --vsix $localVsixPath --only=restart |
            Tee-Object -FilePath $realModelRestartLog
          $realModelRestartExit = $LASTEXITCODE
          Write-Output "real-model restart diagnostic exit code (advisory): $realModelRestartExit"
        }

        # The open-ended real coding task remains separately recorded and
        # non-gating beside the deterministic package-provenance hard gate.
        $liveDiagnosticLog = Join-Path $OutDir 'm35-package-provenance-live-diagnostic.log'
        Write-Output 'Running advisory m35-package-provenance live diagnostic against the exact supplied VSIX...'
        & node.exe scripts/acceptance/run-m32-packaged-dogfood.mjs --vsix $localVsixPath --only=m35-package-provenance-live-diagnostic |
          Tee-Object -FilePath $liveDiagnosticLog
        $liveDiagnosticExit = $LASTEXITCODE
        Write-Output "m35-package-provenance-live-diagnostic exit code (advisory): $liveDiagnosticExit"
      }
      finally {
        if ($null -eq $priorWarmupSkip) { Remove-Item Env:KARKEDIKHA_SKIP_REAL_MODEL_WARMUP -ErrorAction SilentlyContinue }
        else { $env:KARKEDIKHA_SKIP_REAL_MODEL_WARMUP = $priorWarmupSkip }
      }
    }
  }
  finally {
    $evidenceSrc = Join-Path $srcDir '.acceptance-evidence'
    if (Test-Path $evidenceSrc) {
      Copy-Item -Recurse -Force $evidenceSrc (Join-Path $OutDir 'acceptance-evidence')
    }
    Pop-Location
  }

  # Exit code 2 (NOT_ATTEMPTED) and 3 (INFRA_BLOCKED) from advisory live
  # diagnostics remain visible in their evidence but never determine the
  # deterministic packaged-acceptance exit. Required activation, M35, and
  # M36 scenarios are classified below from their own exit codes only.
}
finally {
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}

$classificationInputPath = Join-Path $OutDir 'windows-packaged-acceptance-classification-input.json'
$summaryPath = Join-Path $OutDir 'windows-packaged-acceptance-summary.json'
$realModelDiagnosticLogs = @($realModelRestartLog, $liveDiagnosticLog) | Where-Object { $_ }
$classificationInput = [ordered]@{
  headSha              = $HeadSha
  runId                = $RunId
  vsixPath             = $VsixPath
  vsixBytes            = $vsixBytes
  vsixSha256           = $vsixHasher.Hash.ToLowerInvariant()
  activationExitCode   = $activationExit
  m36AttachmentRestartExitCode = $m36Exit
  m36DocumentAudioRestartExitCode = $m36Pass2Exit
  m36GovernedResearchRestartExitCode = $m36ResearchExit
  m36CombinedWorkbenchExitCode = $m36CombinedExit
  m39MemoryKnowledgeRestartExitCode = $m39Exit
  mandatoryScenariosExitCode = $mandatoryScenariosExit
  realModelWarmup = $realModelWarmupEvidence
  realModelDiagnostics = @(
    [ordered]@{ name = 'restart'; exitCode = $realModelRestartExit; logPath = $realModelRestartLog },
    [ordered]@{ name = 'package-provenance-live'; exitCode = $liveDiagnosticExit; logPath = $liveDiagnosticLog }
  )
  advisoryCdpReadiness = Get-AdvisoryCdpReadiness $realModelDiagnosticLogs
  livePackageProvenanceDiagnosticExitCode = $liveDiagnosticExit
  realModelRestartDiagnosticExitCode = $realModelRestartExit
  scenariosExitCode    = $mandatoryScenariosExit
  scenariosRequested   = $Scenarios
  generatedAt          = (Get-Date).ToUniversalTime().ToString('o')
}
if ($null -eq $classificationInput.realModelWarmup) {
  $classificationInput.realModelWarmup = [ordered]@{ status = 'not_run'; exitCode = $realModelWarmupExit }
} else {
  $classificationInput.realModelWarmup | Add-Member -NotePropertyName exitCode -NotePropertyValue $realModelWarmupExit -Force
}
Write-JsonEvidence $classificationInputPath $classificationInput
& node.exe scripts/acceptance/windowsPackagedAcceptanceHarness.mjs --input $classificationInputPath --output $summaryPath
Assert-LastExitCode 'classify Windows packaged acceptance evidence'
$summaryRaw = [System.IO.File]::ReadAllText($summaryPath, [System.Text.UTF8Encoding]::new($false))
if ($summaryRaw.Length -gt 0 -and [int][char]$summaryRaw[0] -eq 0xfeff) { $summaryRaw = $summaryRaw.Substring(1) }
try {
  $summary = $summaryRaw | ConvertFrom-Json
}
catch {
  $summaryParseEvidence = [ordered]@{
    status = 'classification_summary_parse_failure_not_product_failure'
    summaryPath = $summaryPath
    originalSummary = $summaryRaw
    parseError = $_.Exception.Message
  }
  Write-JsonEvidence (Join-Path $OutDir 'windows-packaged-acceptance-summary-parse-error.json') $summaryParseEvidence
  throw "Windows packaged acceptance classifier summary could not be parsed; this is a harness JSON classification failure, not a product failure. See $OutDir. $($_.Exception.Message)"
}
$overallStatus = $summary.status
Write-Output "Windows packaged acceptance summary: $($summary | ConvertTo-Json -Compress)"

if (-not $summary.acceptancePassed) {
  throw "Windows packaged acceptance FAILED required gates: $($summary.acceptanceFailures | ConvertTo-Json -Compress). See $OutDir for logs and evidence."
}
