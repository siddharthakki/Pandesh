/**
 * Operator checklist for Local Voice human acceptance.
 * Fixtures support automation; they do not replace mic/speaker proof.
 *
 * Usage (after Desktop is running with wake models + Piper staged):
 *   1. Enable Wake word, confirm indicator shows monitoring (not muted).
 *   2. Say “Hey Jarvis”, then a short question without selecting a repo.
 *  3. Confirm transcript appears and an audible Piper answer plays.
 *   4. Ask a contextual follow-up; confirm continuity.
 *   5. Press Stop speaking mid-answer (button interrupt — not spoken barge-in).
 *   6. Select a repo and request one supported Local Core action.
 *
 * Record timings from Desktop host log / console:
 *   wake detectMs, end-of-speech-to-transcript ms, synthesizeMs / first audio.
 */
console.log(`Local Voice human acceptance checklist

1. Enable Wake word — persistent indicator must show monitoring; Mute must silence immediately.
2. Speak “Hey Jarvis”, then a question (no repository required for ordinary chat).
3. Confirm Whisper transcript + audible Piper reply (Voice replies on).
4. Ask a follow-up that depends on prior context.
5. Press Stop speaking during playback (button interrupt). Spoken barge-in is NOT claimed while mic is suppressed.
6. With a repository selected, run one governed Local Core / mission action.

Timings to capture: wakeDetectMs, endOfSpeechToTranscriptMs, synthesizeMs/firstAudio.
Fixtures do not replace this checklist.
`);
