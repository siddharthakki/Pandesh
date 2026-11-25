# Voice recognition measurement — 2026-11-10

What Pandesh's local speech recognition actually hears, measured through the product's own pipeline: the bundled
quantized `whisper-base.en` (`@xenova/transformers` 2.17.2, WASM) in `core/attachments/audioProcessing.ts`, followed by
the host's vocabulary correction (`apps/desktop/src/host/voiceTranscript.ts`).

**Limit of this record: every utterance below is synthetic speech** (text-to-speech voices installed on the test PC).
No real human recording has been measured yet, so these numbers are not the accuracy for a real voice. Real accents,
microphones and rooms are usually harder than clean synthetic speech. The harness below measures real recordings with
the same pipeline; that is the next step.

## Method

- Phrase set: [`scripts/voice/phrases.tsv`](../../scripts/voice/phrases.tsv). It has 30 phrases in five groups: Indian
  names (8), mixed language such as Hinglish and German-English (6), technical vocabulary (8), Pandesh's own words (4),
  and controls (4). Controls are ordinary English that must come back unchanged ("The punishment should fit the
  crime", "Pull llama three…").
- Voices: Piper `en_US-lessac-medium` (US English) and Windows SAPI "Microsoft Zira" (US English). The third voice,
  Windows SAPI "Microsoft Hedda", is a German voice reading the English text. It is a rough stand-in for accented
  speech, not a model of any real speaker. No Indian-English voice was installed on the test PC.
- Scoring: word error rate (WER) against the phrase text, and whether each key word came through as written. Key words
  are counted before and after the host's vocabulary correction. For controls, the score is whether the correction
  changed anything.
- Run: `node scripts/voice/measure-asr.mjs --piper <piper.exe> --tts piper:<voice.onnx> --tts "sapi:Microsoft Zira Desktop" --tts "sapi:Microsoft Hedda Desktop" --model-dir <models/whisper-base-en>`

## Results (synthetic speech)

| voice | group | WER | key words heard | after correction | controls changed |
|---|---|---|---|---|---|
| Piper en-US | names | 19% | 6/11 | 6/11 | |
| Piper en-US | mixed language | 79% | 3/7 | 3/7 | |
| Piper en-US | technical | 15% | 8/12 | 8/12 | |
| Piper en-US | Pandesh words | 23% | 0/4 | 2/4 | |
| Piper en-US | controls | 16% | | | 0/4 |
| Zira en-US | names | 23% | 5/11 | 5/11 | |
| Zira en-US | mixed language | 75% | 5/7 | 5/7 | |
| Zira en-US | technical | 21% | 7/12 | 7/12 | |
| Zira en-US | Pandesh words | 19% | 0/4 | 3/4 | |
| Zira en-US | controls | 4% | | | 0/4 |
| German voice reading English | names | 58% | 3/11 | 3/11 | |
| German voice reading English | mixed language | 86% | 2/7 | 3/7 | |
| German voice reading English | technical | 53% | 3/12 | 3/12 | |
| German voice reading English | Pandesh words | 81% | 0/4 | 1/4 | |
| German voice reading English | controls | 68% | | | 0/4 |

Recognition took a median of 0.97 s per short phrase (90th percentile 1.25 s) after a one-time load of about 5 s, on
the test PC's CPU.

What failed, in the recognizer's own words:

- Short common Indian names mostly came through (Priya, Venkatesh, Lakshmi, Arjun; Rahul with one voice). Long names
  did not: "Kavya Raghunathan" became "Kaverai-Kunathan"; "Thiruvananthapuram" was split or misspelt; "Bengaluru"
  became "Bangalore-Ru" or "Ben Goluru".
- Mixed language is mostly lost, because `whisper-base.en` is an English-only model. "Kal ka weather kya hai" became
  "Taokao Huayakai", and "Open the Rechnung folder" became "Open the Rich Nunn folder". With the German voice, one
  phrase came back partly in Korean script.
- Technical terms: "Ollama" became "Alama" or "Alana", and "pull request" became "poll request". "PowerShell" came
  back as "Power Shell" (two words; counted as a miss).
- Pandesh's own words: "Pandesh" became "Pandish", "Panish" or "Pan-dish", and "Ollaya" became "all layer", "Ale" or
  "Oli are". In an earlier run of 2026-11-10 (Piper only), a short German city name was never recognised (0/6). It came
  out as common words such as "on" or "all", and "weather in <city>" once became "whether or not".

## Decisions taken from this

1. **Spoken messages are marked.** The desktop sends `inputModality: 'voice'` with a speech transcript, and Core freezes
   it with the request. The model is then told the message was spoken and asks "Did you mean …?" about an odd or
   alarming word instead of refusing (`core/domain/spokenInput.ts`).
2. **No broad vocabulary correction.** The misheard forms are common words ("on", "all", "poll") or far from the
   target ("Alama" for "Ollama"). Rewriting them would corrupt ordinary sentences: adding "Ollama" to the vocabulary
   would also turn "llama" into "Ollama". The only change adopted is to join a word the recognizer split with a hyphen
   ("Pan-dish" → "Pandesh"). Controls stayed unchanged in every run.
3. **Mixed-language speech needs a different model.** No hint can fix an English-only model hearing Hindi or German.
   Before any model change, measure candidates (for example a multilingual Whisper size) with this harness, on real
   recordings, and weigh their latency.

## Measuring real speech

Record each phrase in `scripts/voice/phrases.tsv` as `<id>.wav` in one folder, for example `n01.wav` for "Remind me to
call Priya at five pm". `.m4a`, `.mp3` and `.ogg` also work when `ffmpeg` is on PATH. Then run:

```
node scripts/voice/measure-asr.mjs --recordings <folder> --label "<speaker>" --model-dir <models/whisper-base-en>
```

The audio and `results.json` stay on the PC that runs it.

## Engine change: Parakeet TDT 0.6B v3 (2026-11-25)

This is the "measure candidates on real recordings" step above. The owner read 14 sentences into the USB microphone
(English, English with Indian names, company and technical terms, German, and mixed English/German; script in
`.tmp/asrbench/sentences.json` at the time, audio kept local and not committed). Same files, CPU only, 4 threads, 190
words:

| engine | word error | German | mixed | seconds per 12 s clip | RAM |
|---|---|---|---|---|---|
| whisper-base.en (before) | 42.1% | 91% | 72% | 1.1 | 1.8 GB |
| Whisper large-v3-turbo | 15.8% | 4% | 21% | 3.7 | 1.8 GB |
| Parakeet TDT v3 int8, greedy | 17.4% | 17% | 26% | 0.6 | 1.0 GB |

Parakeet was chosen: it is within 3 words of turbo overall, 6x faster, uses half the memory, and needs no VRAM. Turbo is
clearly better on pure German (only two clips), so keep testing German speech. Neither model gets "Rechnung" right
inside an English sentence on its own ("rationale"/"rationum").

Through the shipped code path (`runLocalTranscription`, beam search, 2.5 s first call then about 0.9 s per clip):

| setting | word error |
|---|---|
| no vocabulary | 15.3% |
| `voice-vocabulary.json` (hotwords, score 2) | 13.2% |
| same, while gemma4:12b is generating (GPU 93% busy) | 13.2%, 0.86 s per clip, no VRAM change |

The vocabulary is the owner's own file (`voice-vocabulary.json` in the desktop data folder), passed to the decoder as
hotwords. It fixed "Conficars" and "Pandesh" but not "Rechnung" in an English sentence, and at score 4 it started
dropping real words ("euros"), so the default is 2. These terms were also in the measurement set, so the gain on them
is in-sample. Hotwords are matched to the exact word pieces the model emits, so the engine tries every plausible split.

Failure mode worth knowing: a damaged `tokens.txt` makes the native runtime exit the whole process instead of raising an
error, so the engine checks the exact size of every model file before loading and falls back to whisper-base.en.
