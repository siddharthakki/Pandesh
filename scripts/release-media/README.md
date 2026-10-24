# KarkeDikha release-media harness

This harness turns the existing installed-product Guardian journeys into repeatable release screenshots and short demo videos.

It deliberately reuses the real packaged VS Code extension, the existing `vscode-extension-tester` UI driver, the real KarkeDikha webview, visible approval controls, and Guardian evidence capture. It does **not** add demo-only paths to the extension runtime.

## Prerequisites

Windows, Node/npm, Git, and FFmpeg/FFprobe must be on `PATH`.

FFmpeg can be installed with:

```powershell
winget install Gyan.FFmpeg
```

## Deterministic showcase capture

Use this for README/release screenshots and repeatable product walkthroughs:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release-media\capture-release-media.ps1
```

Showcase mode uses Guardian's deterministic local fake-Ollama server. The UI, packaged extension, repository mutations, approvals, persistence, and validation paths are real; the language-model response is scripted by the test harness. Do not present showcase output as a benchmark of a real model.

## Real local-model capture

Use this when the media must prove behavior through an actual local Ollama model:

```powershell
$env:KKD_MEDIA_MODEL = 'hf.co/Abiray/KAT-Coder-V2.5-Dev-Imatrix-GGUF:IQ4_XS'
$env:KKD_MEDIA_OLLAMA_URL = 'http://127.0.0.1:11434'

powershell -ExecutionPolicy Bypass -File .\scripts\release-media\capture-release-media.ps1 -Mode real
```

Real mode keeps Guardian's installed-product UI automation but replaces the deterministic fake server for model-backed journeys with the configured Ollama endpoint/model.

## Frozen VSIX

By default the harness uses Guardian's frozen VSIX for the current Git HEAD. If it is absent, the harness runs:

```powershell
npm run test:guardian:build-vsix
```

A specific artifact can be supplied instead:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release-media\capture-release-media.ps1 `
  -VsixPath C:\path\to\karkedikha-v0.1.0-preview.vsix
```

For release media, prefer the exact VSIX that is attached to the release.

## Output

The harness writes:

```text
docs/media/
  screenshots/
    01-hero.png
    02-baat-kar.png
    03-saath-kar.png
    04-saath-kar-continuity.png
    05-karke-dikha.png
    06-governed-continuity.png
  demos/
    01-baat-kar.mp4
    02-saath-kar.mp4
    03-karke-dikha.mp4
  manifest.json
```

The three demo videos are screen recordings of the automated installed-product journeys. They are accelerated to keep the clips short and encoded as 1080p H.264 MP4.

`manifest.json` records the capture mode, source Git HEAD, exact VSIX SHA-256, model identity, file sizes, and video durations.

## Journeys reused

The initial media pack intentionally reuses already-governed product journeys instead of inventing a parallel demo system:

- `baat-kar-complete-history`
- `saath-kar-approved-restoration`
- `deterministic-complete`

This makes release media fail when the corresponding installed-product behavior regresses.

## Useful switches

Screenshots only:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release-media\capture-release-media.ps1 -SkipVideos
```

Videos only:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release-media\capture-release-media.ps1 -SkipScreenshots
```

Custom destination:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release-media\capture-release-media.ps1 -OutputRoot C:\Temp\karkedikha-media
```

## Release policy

- Use **showcase** media for deterministic screenshots and short product walkthroughs.
- Use **real** mode for any claim about model performance, model compatibility, latency, or autonomous reasoning.
- Never hide a failed real-model run by replacing it with showcase output while still describing the result as real-model behavior.
- The media harness stays under `scripts/release-media`; no release-media behavior belongs in the production extension runtime.
