/** Shared wake-word tuning for Desktop host + worker (keep values aligned). */
export const WAKE_SCORE_THRESHOLD = 0.45;
/** openWakeWord needs 16 embedding frames (~1.28s) before the classifier can fire. */
export const WAKE_WARMUP_EMBEDDINGS = 16;
/** Frames @ 80ms that approximate warmup for UI (16 embeddings). */
export const WAKE_WARMUP_AUDIO_FRAMES = 16;
