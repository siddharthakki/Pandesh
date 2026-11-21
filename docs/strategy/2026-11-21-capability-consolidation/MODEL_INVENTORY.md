# Model inventory and storage strategy (2026-11-21)

Hardware: RTX 3090 24 GB, Ryzen 9 5900X, 64 GB RAM.

**Method:** `node scripts/inventory/model-store-inventory.mjs --full-hash` (branch feat/capability-consolidation, 06de824).
- Metadata only and read-only.
- GGUF headers are parsed for architecture and quantization.
- Duplicates are found by size plus a sampled fingerprint, then confirmed with a full SHA-256.

Full output: [evidence/model-inventory-2026-11-21.md](evidence/model-inventory-2026-11-21.md). **Nothing was moved, linked or deleted.**

## Engines found

| Engine | Version / location | Model store | Size on disk |
|---|---|---|---|
| Ollama | 0.40.17 | `C:\Users\<you>\.ollama\models` (20 model blobs, 15 listed models) | 117.95 GB |
| Strata | `D:\AI\Strata`, data `D:\AI\Strata-data` | GGUF + tensor packs | 136.71 GB |
| Hugging Face cache | `HF_HOME=E:\AI\huggingface` | `hub\models--*` | 43.63 GB |
| InferenceLab (TQ / DFlash experiments) | `D:\AI\InferenceLab` | GGUF | 14.2 GB |
| llama.cpp | WinGet build 10853 | no store of its own found | — |
| LM Studio | `lms` CLI, `~\.lmstudio\models` | no files ≥ 50 MB | — |
| vLLM-tev, Kokon | `D:\AI\vllm-tev`, `D:\AI\Kokon` | none ≥ 50 MB found | — |
| ComfyUI Image Studio | `C:\Projects\ImageGeneration` | none ≥ 50 MB found under that path (its models may be elsewhere; not traced) | — |
| **Total scanned** | | | **312.5 GB** |

## Ollama models

| Model | Size | Architecture | Quantization |
|---|---|---|---|
| qwen3-coder:swift-27b (+ 0.86 GB vision projector) | 16.79 GB | qwen35 | Q4_K_M |
| qwen3.8:27b-mtp-q4_K_M (+ 0.87 GB projector) | 15.66 GB | qwen35 | Q4_K_M |
| gemma4:26b-a4b-it-qat (+ 1.11 GB projector) | 13.45 GB | gemma4 | Q4_0 |
| gpt-oss:20b | 12.85 GB | gptoss | MXFP4-class |
| `llamacpp:9ba9cc2b…` (hidden manifest, not in `ollama list`) | 12.85 GB | gpt-oss | different bytes from gpt-oss:20b |
| DeepSeek-V4-Pro-Qwen3.5-9B heretic Q8_0 (hf.co) | 8.87 GB | qwen35 | Q8_0 |
| TwIL-8B Q8_0 (hf.co) | 8.70 GB | granite | Q8_0 |
| Mellum2.1-12B-A2.5B Thinking (hf.co) | 7.52 GB | mellum | Q4_K_M |
| gemma4:12b | 6.87 GB | gemma4 | Q4_K_M |
| qwen2.5vl:7b | 5.56 GB | qwen25vl | Q4_K_M |
| Qwen3-Embedding-4B | 2.33 GB | qwen3 | Q4_K_M |
| qwen2.5-coder:3b | 1.80 GB | qwen2 | Q4_K_M |
| Qwen3-Reranker-0.6B | 0.60 GB | qwen3 | Q8_0 |
| functiongemma:270m, nomic-embed-text | 0.28 / 0.26 GB | gemma3 / nomic-bert | Q8_0 / F16 |

`qwen9b-fixed:latest` (10 GB in `ollama list`) is built FROM the same two blobs as the DeepSeek-V4-Pro 9B entry (verified with `POST /api/show`: `FROM …sha256-0bc2a889…` and `…sha256-42596b1e…`). Ollama stores them once, so it costs no extra disk.

**Tool limitation:** this model's manifest is not under `manifests\` on disk (Ollama 0.40 appears to keep created models elsewhere), so the file scan does not attribute those blobs to it. The API-based `scripts/model-inventory-audit.mjs` sees every listed model; the two tools should be joined. That is a follow-up.

## Confirmed duplicates: byte-identical by full SHA-256 (74.27 GB)

| Copies | Size each | Where | Likely cause |
|---|---|---|---|
| 2 | 36.53 GB | `D:\AI\Strata-data\models\IQ2_XS\` and `…\IQ2_XS\IQ2_XS\` (part 1 of 2) | A nested copy from an extract or move |
| 2 | 26.82 GB | same, part 2 of 2 | same |
| 2 | 8.75 GB | HF `unsloth/Qwen-Image-2.1-FP8` text encoder, two snapshots | HF cache on Windows without symlinks keeps full copies per revision |
| 2 | 0.78 GB | HF `convaiinnovations/laya` model, two snapshots | same |
| 2 | 0.78 GB | HF laya `typed-decisions` | same |
| 2 | 0.60 GB | HF laya `multilingual` | same |

**Safe reclaim, when you approve it:**
- **Strata:** delete one of the two IQ2_XS copies (63.35 GB). First check which path Strata's config points at.
- **Hugging Face:** `huggingface-cli delete-cache` removes the older revision of each repo (10.9 GB). Don't delete snapshot files by hand.

## Not duplicates, though they look like it
- Different quantizations of the same family (the Qwen-Image 2.1 GGUF Q4_K_M vs FP8 vs full safetensors) are different files with different uses.
- The Ollama `llamacpp:` gpt-oss blob has the same size as `gpt-oss:20b` but different bytes (sampled fingerprints differ). Run `ollama show` on it before deciding.

## Can engines share one store?
- **Ollama** keeps GGUF weights as content-addressed blobs (`blobs/sha256-…`). **llama.cpp, LM Studio and Strata can load those files directly** by path, because a model blob is a plain GGUF. So the reverse direction works: point other engines at Ollama blobs, read-only.
  - Do not hard-link into Ollama's blob folder: Ollama prunes and verifies blobs by digest.
  - Do not point Ollama at loose GGUF files except through `ollama create` from a Modelfile `FROM <path>`. That copies the file into a blob once.
- **Hugging Face** safetensors (diffusion, Whisper, TTS) are a different format family. They stay in the HF cache; ComfyUI and faster-whisper read them from there via `HF_HOME`.
- **Strata** packs (`*.bin` tensor packs, mtp) are engine-specific and can't be shared.

## Proposed structure (design only; nothing moved)

```
E:\AI\models\
  gguf\<family>\<model>-<quant>.gguf      (llama.cpp, LM Studio, Strata, InferenceLab read from here)
  hf\  (HF_HOME, unchanged)
  engine-specific\strata\  engine-specific\comfyui\
Ollama: stays in its own store; other engines may read its blobs through a generated read-only index (model name → blob path).
```

**Next tooling step** (small, read-only): add `--index` to the inventory script. It would write `model-index.json` (name → path, format, quant, engines that can load it), which LM Studio, llama.cpp and Strata configs can consult.

**Potential savings:**
- 74.27 GB now, from confirmed duplicates.
- A further 12.85 GB if the hidden `llamacpp:` blob turns out to be unused.
