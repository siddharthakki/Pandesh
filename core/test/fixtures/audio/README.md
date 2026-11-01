# Audio test fixtures

## quarterly-report-speech.wav

Synthetic speech used by the local-transcription tests (`audioProcessing`, `attachmentUpload`,
`attachmentExecution`, desktop `desktopLocalSpeech`) and the packaged M36 acceptance harness.
Transcribing it must yield "quarterly report" and "steady growth".

- Text: `The quarterly report shows steady growth.` (written for this project)
- Engine: Piper `piper_windows_amd64` release `2023.11.14-2` (the version pinned in `scripts/fetch-piper.mjs`)
- Voice: `en_US-ljspeech-medium` from `rhasspy/piper-voices`. The model card lists the training dataset
  (LJ Speech, https://keithito.com/LJ-Speech-Dataset/) as **public domain**.
- Format: 22,050 Hz, 16-bit, mono WAV, 107,680 bytes
- SHA-256: `eee3ea6fd5e003a042690c3099dfdbb42b612b6a2270b64b358843805871daf8`

Regenerate (output is deterministic with zero noise):

```
echo The quarterly report shows steady growth. | piper.exe --model en_US-ljspeech-medium.onnx --config en_US-ljspeech-medium.onnx.json --noise_scale 0 --noise_w 0 --output_file quarterly-report-speech.wav
```

Do not substitute the bundled `en_US-lessac-medium` voice or an OS voice (e.g. Windows SAPI): their
redistribution terms for generated audio are not established. An earlier fixture generated with
Windows SAPI (Microsoft Zira) was replaced for that reason.
