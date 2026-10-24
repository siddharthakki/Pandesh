import { describe, expect, it } from 'vitest';
import { WAKE_SCORE_THRESHOLD, WAKE_WARMUP_AUDIO_FRAMES } from '../src/host/wakeWordConfig';

describe('wake reliability tuning', () => {
  it('uses a desktop threshold below the stock 0.5 openWakeWord default', () => {
    expect(WAKE_SCORE_THRESHOLD).toBeGreaterThanOrEqual(0.4);
    expect(WAKE_SCORE_THRESHOLD).toBeLessThan(0.5);
  });

  it('requires warmup frames before readyForDetect', () => {
    expect(WAKE_WARMUP_AUDIO_FRAMES).toBe(16);
    const framesSinceReset = 8;
    expect(framesSinceReset >= WAKE_WARMUP_AUDIO_FRAMES).toBe(false);
    expect(16 >= WAKE_WARMUP_AUDIO_FRAMES).toBe(true);
  });

  it('keeps wakeThreshold.mjs aligned with the host constant', async () => {
    const mod = await import('../scripts/wakeThreshold.mjs');
    expect(mod.WAKE_SCORE_THRESHOLD).toBe(WAKE_SCORE_THRESHOLD);
  });
});
