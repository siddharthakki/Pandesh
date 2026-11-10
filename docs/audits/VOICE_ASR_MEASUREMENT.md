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
