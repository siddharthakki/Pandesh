[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://localhost:11434',
    [string]$Model
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$base = $BaseUrl.TrimEnd('/')
$tags = Invoke-RestMethod -Uri "$base/api/tags" -Method Get -TimeoutSec 10
$models = @($tags.models | ForEach-Object {
    if ($_.name) { [string]$_.name }
    elseif ($_.model) { [string]$_.model }
}) | Where-Object { $_ }

if ($models.Count -eq 0) {
    throw 'Live Ollama smoke requires at least one installed model.'
}

$preferred = @('qwen2.5-coder:1.5b', 'llama3.2:1b')
if (-not $Model -or $models -notcontains $Model) {
    $Model = $preferred | Where-Object { $models -contains $_ } | Select-Object -First 1
}
if (-not $Model) { $Model = $models[0] }

$marker = 'KARKEDIKHA_SMOKE_OK'
$payload = @{
    model = $Model
    stream = $false
    messages = @(
        @{ role = 'system'; content = 'Follow the user output format exactly.' }
        @{ role = 'user'; content = "Reply with exactly this token and nothing else: $marker" }
    )
    options = @{ temperature = 0 }
} | ConvertTo-Json -Depth 8

$result = Invoke-RestMethod `
    -Uri "$base/api/chat" `
    -Method Post `
    -ContentType 'application/json' `
    -Body $payload `
    -TimeoutSec 180

$content = [string]$result.message.content
if (-not $content.Contains($marker)) {
    throw "Live Ollama chat smoke returned unexpected content from ${Model}: $($content.Substring(0, [Math]::Min(200, $content.Length)))"
}

Write-Output "PASSED: Ollama readiness succeeded at $base; discovered $($models.Count) model(s)."
Write-Output "PASSED: live Ollama chat response succeeded with $Model."
