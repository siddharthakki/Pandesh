[CmdletBinding()]
param(
    [ValidateSet('showcase', 'real')]
    [string]$Mode = 'showcase',

    [string]$VsixPath = '',

    [string]$OutputRoot = 'docs/media',

    [string]$Model = $env:KKD_MEDIA_MODEL,

    [string]$OllamaUrl = $(if ($env:KKD_MEDIA_OLLAMA_URL) { $env:KKD_MEDIA_OLLAMA_URL } else { 'http://127.0.0.1:11434' }),

    [switch]$SkipVideos,

    [switch]$SkipScreenshots
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..\..')
Push-Location $repoRoot

function Require-Command([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "Required command '$Name' was not found on PATH."
    }
    return $command.Source
}

function Resolve-OutputPath([string]$PathValue) {
    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $PathValue))
}

function Resolve-Vsix([string]$RequestedPath) {
    if ($RequestedPath) {
        $candidate = Resolve-OutputPath $RequestedPath
        if (-not (Test-Path $candidate)) {
            throw "VSIX not found: $candidate"
        }
        return $candidate
    }

    $head = (git rev-parse HEAD).Trim()
    $candidate = Join-Path $repoRoot ".guardian-cache\vsix\$head\karkedikha-win32-x64.vsix"
    if (-not (Test-Path $candidate)) {
        Write-Host "Frozen VSIX not found for $head; building it with Guardian..." -ForegroundColor Cyan
        npm run test:guardian:build-vsix
        if ($LASTEXITCODE -ne 0) {
            throw 'Guardian VSIX build failed.'
        }
    }
    if (-not (Test-Path $candidate)) {
        throw "Guardian build completed but the expected VSIX was not found: $candidate"
    }
    return [System.IO.Path]::GetFullPath($candidate)
}

function Start-DesktopRecording([string]$Destination) {
    $ffmpeg = Require-Command 'ffmpeg'
    $arguments = @(
        '-y',
        '-loglevel', 'warning',
        '-f', 'gdigrab',
        '-framerate', '30',
        '-draw_mouse', '0',
        '-i', 'desktop',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        $Destination
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $ffmpeg
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Arguments = ($arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    Start-Sleep -Milliseconds 900
    return $process
}

function Stop-DesktopRecording([System.Diagnostics.Process]$Process) {
    if (-not $Process -or $Process.HasExited) { return }
    try {
        $Process.StandardInput.WriteLine('q')
        $Process.StandardInput.Flush()
        if (-not $Process.WaitForExit(10000)) {
            $Process.Kill($true)
            $Process.WaitForExit()
        }
    } catch {
        if (-not $Process.HasExited) {
            $Process.Kill($true)
            $Process.WaitForExit()
        }
    }
}

function Convert-ToShortDemo([string]$RawPath, [string]$FinalPath) {
    if (-not (Test-Path $RawPath)) { throw "Raw recording missing: $RawPath" }

    # Guardian journeys include launch/close/reopen lifecycle proof. Speeding the
    # capture to 3x keeps the demo short while preserving the real visible UI.
    $filter = 'setpts=0.333333*PTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2'
    & ffmpeg -y -loglevel warning -i $RawPath -vf $filter -an -r 30 -c:v libx264 -preset medium -crf 21 -movflags +faststart $FinalPath
    if ($LASTEXITCODE -ne 0) { throw "Failed to encode $FinalPath" }
}

function Invoke-GuardianJourney([string]$Journey, [string]$Vsix) {
    Write-Host "Running Guardian journey: $Journey" -ForegroundColor Cyan
    & node scripts/guardian/run-guardian.mjs p1 --only $Journey --vsix $Vsix
    if ($LASTEXITCODE -ne 0) {
        throw "Guardian journey failed: $Journey"
    }

    $latest = Get-ChildItem (Join-Path $repoRoot '.guardian-evidence') -Directory |
        Where-Object { $_.Name -like '*-p1' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (-not $latest) { throw "No Guardian evidence directory was produced for $Journey" }
    $evidence = Join-Path $latest.FullName "$Journey\evidence"
    if (-not (Test-Path $evidence)) {
        throw "Expected Guardian evidence was not found: $evidence"
    }
    return $evidence
}

function Copy-Screenshot([string]$EvidenceDir, [string]$SourceName, [string]$Destination) {
    $source = Join-Path $EvidenceDir $SourceName
    if (-not (Test-Path $source)) {
        throw "Expected screenshot was not produced: $source"
    }
    Copy-Item $source $Destination -Force
}

function Get-VideoDuration([string]$PathValue) {
    $duration = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $PathValue
    if ($LASTEXITCODE -ne 0) { return 0 }
    return [double]::Parse(($duration | Select-Object -First 1), [System.Globalization.CultureInfo]::InvariantCulture)
}

try {
    Require-Command 'git' | Out-Null
    Require-Command 'node' | Out-Null
    Require-Command 'npm' | Out-Null
    Require-Command 'ffmpeg' | Out-Null
    Require-Command 'ffprobe' | Out-Null

    if ($Mode -eq 'real') {
        if (-not $Model) {
            throw 'Real mode requires -Model or KKD_MEDIA_MODEL.'
        }
        $env:GUARDIAN_LIVE_MODEL_BASE_URL = $OllamaUrl
        $env:GUARDIAN_LIVE_MODEL_NAME = $Model
        Write-Host "REAL mode: Guardian will use $Model at $OllamaUrl" -ForegroundColor Yellow
    } else {
        Remove-Item Env:GUARDIAN_LIVE_MODEL_BASE_URL -ErrorAction SilentlyContinue
        Remove-Item Env:GUARDIAN_LIVE_MODEL_NAME -ErrorAction SilentlyContinue
        Write-Host 'SHOWCASE mode: deterministic Guardian fake Ollama will be used.' -ForegroundColor Yellow
        Write-Host 'Use -Mode real when you need proof of actual local-model behavior.' -ForegroundColor DarkYellow
    }

    $resolvedVsix = Resolve-Vsix $VsixPath
    $output = Resolve-OutputPath $OutputRoot
    $screens = Join-Path $output 'screenshots'
    $demos = Join-Path $output 'demos'
    $rawDir = Join-Path $output '.raw'
    New-Item -ItemType Directory -Force -Path $screens, $demos, $rawDir | Out-Null

    $journeys = @(
        @{ Id = 'baat-kar-complete-history'; Video = '01-baat-kar.mp4' },
        @{ Id = 'saath-kar-approved-restoration'; Video = '02-saath-kar.mp4' },
        @{ Id = 'deterministic-complete'; Video = '03-karke-dikha.mp4' }
    )

    $evidenceByJourney = @{}
    foreach ($journey in $journeys) {
        $rawVideo = Join-Path $rawDir ($journey.Id + '.mp4')
        $recorder = $null
        try {
            if (-not $SkipVideos) {
                $recorder = Start-DesktopRecording $rawVideo
            }
            $evidenceByJourney[$journey.Id] = Invoke-GuardianJourney $journey.Id $resolvedVsix
        } finally {
            if ($recorder) { Stop-DesktopRecording $recorder }
        }

        if (-not $SkipVideos) {
            $finalVideo = Join-Path $demos $journey.Video
            Convert-ToShortDemo $rawVideo $finalVideo
        }
    }

    if (-not $SkipScreenshots) {
        Copy-Screenshot $evidenceByJourney['baat-kar-complete-history'] 'baat-primary.png' (Join-Path $screens '01-hero.png')
        Copy-Screenshot $evidenceByJourney['baat-kar-complete-history'] 'baat-restored.png' (Join-Path $screens '02-baat-kar.png')
        Copy-Screenshot $evidenceByJourney['saath-kar-approved-restoration'] 'saath-approved.png' (Join-Path $screens '03-saath-kar.png')
        Copy-Screenshot $evidenceByJourney['saath-kar-approved-restoration'] 'saath-approved-restored.png' (Join-Path $screens '04-saath-kar-continuity.png')
        Copy-Screenshot $evidenceByJourney['deterministic-complete'] 'deterministic-complete.png' (Join-Path $screens '05-karke-dikha.png')
        Copy-Screenshot $evidenceByJourney['deterministic-complete'] 'deterministic-restored.png' (Join-Path $screens '06-governed-continuity.png')
    }

    $vsixHash = (Get-FileHash -Algorithm SHA256 $resolvedVsix).Hash.ToLowerInvariant()
    $manifest = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        mode = $Mode
        repositoryHead = (git rev-parse HEAD).Trim()
        vsix = $resolvedVsix
        vsixSha256 = $vsixHash
        model = $(if ($Mode -eq 'real') { $Model } else { 'guardian-deterministic-fake-ollama' })
        ollamaUrl = $(if ($Mode -eq 'real') { $OllamaUrl } else { $null })
        screenshots = @()
        videos = @()
    }

    if (-not $SkipScreenshots) {
        $manifest.screenshots = Get-ChildItem $screens -Filter '*.png' | Sort-Object Name | ForEach-Object {
            [ordered]@{ name = $_.Name; bytes = $_.Length }
        }
        if ($manifest.screenshots.Count -ne 6) {
            throw "Expected 6 screenshots, found $($manifest.screenshots.Count)."
        }
    }

    if (-not $SkipVideos) {
        $manifest.videos = Get-ChildItem $demos -Filter '*.mp4' | Sort-Object Name | ForEach-Object {
            [ordered]@{ name = $_.Name; bytes = $_.Length; durationSeconds = [math]::Round((Get-VideoDuration $_.FullName), 2) }
        }
        if ($manifest.videos.Count -ne 3) {
            throw "Expected 3 videos, found $($manifest.videos.Count)."
        }
        foreach ($video in $manifest.videos) {
            if ($video.durationSeconds -le 0 -or $video.bytes -le 1024) {
                throw "Invalid video output: $($video.name)"
            }
        }
    }

    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $output 'manifest.json')

    Write-Host ''
    Write-Host 'Release media capture completed.' -ForegroundColor Green
    Write-Host "Screenshots: $screens"
    Write-Host "Videos:      $demos"
    Write-Host "Manifest:    $(Join-Path $output 'manifest.json')"
} finally {
    Pop-Location
}
