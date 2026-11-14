# Live local vision check (PR #88)

`mk.ps1` draws a SYNTHETIC WhatsApp-style screenshot (`synthetic-whatsapp.png`, no real data). Run:

    LIVE_VISION_PNG=<path>\synthetic-whatsapp.png LIVE_VISION_OUT=out.json npx vitest run core/test/screenshotLiveVision.test.ts

`live-vision-result.json` is the 2026-11-14 run against the real local Ollama: the already-loaded vision-capable model
`qwen3.8:27b-mtp-q4_K_M` (Ollama reports completion, vision, tools, thinking) read the title and all three messages, including
the code word, in 237 s. No cloud was involved; the endpoint was 127.0.0.1.
