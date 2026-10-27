# Pocket TTS — third-party notices

Pandesh bundles Kyutai's Pocket TTS as an optional, locally-run speech engine.
Nothing is sent off the device at runtime; all inference is CPU-only.

| Component | Version / revision | License |
| --- | --- | --- |
| `pocket-tts.exe` (standalone runtime) | 3.3.0, x86_64-pc-windows-msvc | MIT-style permission notice (see `LICENSE` beside the executable) |
| `model.safetensors`, `tokenizer.model`, `charles.safetensors` (`english_18m_refl_2026-10`) | `kyutai/pocket-tts-without-voice-cloning` @ a7056f50 / 08ffc587 / a3055dcb | CC-BY-4.0 |

Model attribution: "Pocket TTS" by Kyutai (https://huggingface.co/kyutai/pocket-tts-without-voice-cloning),
licensed under Creative Commons Attribution 4.0 International
(https://creativecommons.org/licenses/by/4.0/). No changes were made to the model files.

Kyutai's prohibited-use terms apply to this model: no voice impersonation or cloning without
explicit and lawful consent, no deception or disinformation, and no unlawful, harmful or
privacy-invasive content. Pandesh ships only the built-in "Charles" voice and does not expose voice cloning.
